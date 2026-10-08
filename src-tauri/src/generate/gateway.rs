//! Placing one generation with whoever answers.
//!
//! An adapter knows how to speak to a provider; this module knows which
//! provider to speak to, what to say, and what to do when the first answer is
//! not the last. It is the only place that reads the configuration, the only
//! place that decides between answering at once and starting a job, and the
//! only place a retry happens — so nothing above it has to know that a
//! settings dialog exists, and nothing below it has to know that a node does.
//!
//! One call per capability, because a caller knows what it wants and should
//! not have to say it twice: the endpoint a request arrived on decides the
//! capability, and a body that disagrees is a client bug rather than an
//! instruction.

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use crate::config::GenerateConfig;
use crate::domain::Capability;
use crate::metadata::{Preferences, Protocol, Scene};
use crate::project::store::FsProjectStore;
use crate::project::ProjectStore;
use crate::telemetry::GenerationNote;

use super::adapters::{for_protocol, ModelCall};
use super::error::ProviderError;
use super::jobs::TaskRegistry;
use super::media::{load_inputs, AudioWindow, MediaInput};
use super::models::{resolve_within, ModelRepo, ResolvedModel};
use super::{AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, InputRole, TaskState};

/// One generation, resolved and ready to send.
///
/// Holds the plaintext credential for as long as it is alive, which is why it
/// is built at the last moment before a request and dropped when the attempts
/// are over.
struct Placement {
    call: ModelCall,
    request: GenerateRequest,
    inputs: Vec<MediaInput>,
}

/// Places generations with the models the user configured.
pub struct Gateway {
    models: Arc<ModelRepo>,
    budgets: GenerateConfig,
    /// What cuts a window out of a recording, where the deployment has one. A
    /// caller that named a window and got a whole file instead would be
    /// answered about audio it never asked about, so a window with nothing to
    /// cut it is refused.
    audio: Option<Arc<dyn AudioWindow>>,
    tasks: TaskRegistry,
}

impl Gateway {
    pub fn new(
        models: Arc<ModelRepo>,
        budgets: GenerateConfig,
        audio: Option<Arc<dyn AudioWindow>>,
    ) -> Self {
        Self {
            models,
            budgets,
            audio,
            tasks: TaskRegistry::new(),
        }
    }

    /// Written text.
    ///
    /// `sink` is where the answer goes as it arrives, and passing one that
    /// somebody is watching is what asks a provider for a stream at all. What
    /// comes back is the whole answer either way, because the whole answer is
    /// what gets stored.
    pub async fn text(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        sink: &DeltaSink,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        self.answer(session, stamped(request, Capability::Text), sink, cancel)
            .await
    }

    /// A picture, with or without something to edit or imitate.
    pub async fn image(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        self.answer(
            session,
            stamped(request, Capability::Image),
            &DeltaSink::default(),
            cancel,
        )
        .await
    }

    /// Speech.
    pub async fn speech(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        self.answer(
            session,
            stamped(request, Capability::Speech),
            &DeltaSink::default(),
            cancel,
        )
        .await
    }

    /// A score.
    pub async fn music(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        self.answer(
            session,
            stamped(request, Capability::Music),
            &DeltaSink::default(),
            cancel,
        )
        .await
    }

    /// A shot, started rather than waited out.
    ///
    /// Video is always a job: one takes minutes, and holding a request open
    /// that long would tie the caller's connection to a provider's queue. The
    /// handle comes back at once and is polled through [`Gateway::poll`].
    pub async fn video(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        self.start_job(session, stamped(request, Capability::Video), cancel)
            .await
    }

    /// A recording, read back as words.
    ///
    /// A job for the same reason a shot is: an hour of speech takes minutes to
    /// recognize, and the request carries the audio itself rather than a body
    /// of a few words.
    pub async fn transcribe(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        self.start_job(session, stamped(request, Capability::Asr), cancel)
            .await
    }

    /// One job started, whichever capability asked for it.
    async fn start_job(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        let placement = self.place(session, request, cancel).await?;
        let adapter = for_protocol(placement.call.protocol.clone());
        let started = Instant::now();
        let task = self
            .retried(
                cancel,
                || async {
                    adapter
                        .create_task(
                            &placement.call,
                            &placement.request,
                            &placement.inputs,
                            cancel,
                        )
                        .await
                },
                waitable,
            )
            .await;
        match &task {
            // A shot that started is a call that happened. What it will answer
            // with is a later poll's business, so nothing is counted here.
            Ok(_) => self.logged(&placement, started.elapsed(), 0, "started"),
            Err(error) => self.logged(&placement, started.elapsed(), 0, error.code()),
        }
        let task = task?;
        // Tracked before the handle is handed back: a client that polls at
        // once must not find it missing.
        self.tasks.register(task.clone());
        self.noted(session, &task).await;
        Ok(task)
    }

    /// What one call is worth writing down, said once it is over.
    ///
    /// Once per placement rather than once per attempt or once per poll: a
    /// retry that succeeded is one call from where a reader sits, and a shot
    /// that took a hundred looks would otherwise write a hundred lines about
    /// itself. The note is built from the call rather than spelled out here so
    /// that what must stay out of it stays out whichever way it is written.
    fn logged(&self, placement: &Placement, took: Duration, bytes: u64, status: &str) {
        let note = GenerationNote::of(&placement.call, &placement.request, took, bytes, status);
        tracing::info!(target: "moka::generate", "{note}");
    }

    /// How many looks at a job before it is given up on.
    ///
    /// Read off the budgets rather than left as a constant in the caller: the
    /// wait a deployment is willing to sit through is a number it sets, and a
    /// progress fraction reported against a different ceiling than the one
    /// being counted would be a lie.
    pub fn poll_ceiling(&self) -> u32 {
        self.budgets.poll_ceiling()
    }

    /// Writes a job down beside the run history.
    ///
    /// A shot takes minutes and this process may not last them, so what is
    /// written here is the difference between picking a job up again after a
    /// restart and reporting one already paid for as never heard of. Failing to
    /// write it is a warning rather than an error: the job is running either
    /// way, and refusing the handle would lose it.
    async fn noted(&self, session: &Arc<FsProjectStore>, task: &AsyncTask) {
        let Ok(record) = serde_json::to_value(task) else {
            return;
        };
        if let Err(error) = session.record_job(&task.id, record).await {
            tracing::warn!("job {}: could not be written down: {error}", task.id);
        }
    }

    /// The job a handle names, read back from the note beside the run history
    /// when this process has not seen it.
    ///
    /// A note that cannot be read is taken for one that is not there: the job it
    /// named cannot be asked after either way, and what a caller needs is one
    /// answer rather than an account of the disk.
    async fn recall(&self, session: &Arc<FsProjectStore>, task: &str) -> Option<AsyncTask> {
        let record = session.job(task).await.ok().flatten()?;
        serde_json::from_value(record).ok()
    }

    /// A job that will not answer again, dropped from the table and from the
    /// note that outlived the request which started it.
    async fn settled(&self, session: &Arc<FsProjectStore>, task: &str) {
        self.tasks.forget(task);
        if let Err(error) = session.drop_job(task).await {
            tracing::warn!("job {task}: the note of it could not be dropped: {error}");
        }
    }

    /// One look at a job started here.
    pub async fn poll(
        &self,
        session: &Arc<FsProjectStore>,
        task: &str,
        cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        let tracked = match self.tasks.get(task) {
            Ok(tracked) => tracked,
            // A restart empties the table without ending the job.
            Err(ProviderError::TaskMissing { .. }) => match self.recall(session, task).await {
                Some(recalled) => {
                    self.tasks.register(recalled.clone());
                    recalled
                }
                None => {
                    return Err(ProviderError::TaskMissing {
                        task: task.to_string(),
                    })
                }
            },
            Err(error) => return Err(error),
        };
        cancel.check()?;
        // The job stays with the model configuration that started it. Polling
        // through whatever the default is now would ask one provider about a
        // handle another issued.
        let snapshot = self.models.snapshot().await?;
        let resolved =
            resolve_within(&snapshot, &tracked.model, tracked.capability, tracked.scene)?;
        let call = self.address(&resolved).await?;
        let state = for_protocol(tracked.protocol.clone())
            .poll_task(&call, &tracked, cancel)
            .await;
        match &state {
            Ok(TaskState::Pending { .. }) => {}
            // A job that answered is done with, and one the provider has
            // forgotten cannot answer again: keeping either handle would only
            // grow the table.
            Ok(TaskState::Succeeded(_) | TaskState::Failed { .. }) => {
                self.settled(session, task).await
            }
            Err(ProviderError::TaskExpired { .. }) => self.settled(session, task).await,
            // Anything else is this process failing to look rather than the
            // job ending, and dropping the handle would lose a shot the
            // provider is still making.
            Err(_) => {}
        }
        // Applied after the handle is let go: a job that answered is done with
        // whether or not the answer can be kept, and holding the handle would
        // only invite a poll for something that has already been refused.
        state.and_then(|state| match state {
            TaskState::Succeeded(result) => kept(result, &self.budgets).map(TaskState::Succeeded),
            other => Ok(other),
        })
    }

    /// The jobs being tracked.
    pub fn tasks(&self) -> &TaskRegistry {
        &self.tasks
    }

    /// One answer, waited out or read as it arrives.
    async fn answer(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        sink: &DeltaSink,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        let placement = self.place(session, request, cancel).await?;
        let (forwarded, watching) = counting(sink);
        let streaming = watching.is_streaming();
        let adapter = for_protocol(placement.call.protocol.clone());
        let started = Instant::now();
        let outcome = self
            .retried(
                cancel,
                || async {
                    if streaming {
                        adapter
                            .generate_stream(
                                &placement.call,
                                &placement.request,
                                &placement.inputs,
                                &watching,
                                cancel,
                            )
                            .await
                    } else {
                        adapter
                            .generate(
                                &placement.call,
                                &placement.request,
                                &placement.inputs,
                                cancel,
                            )
                            .await
                    }
                },
                // A stream that already showed something cannot be started
                // again: a second attempt would put the same words on screen
                // twice, and a caller has no way to unsee the first lot.
                |error| waitable(error) && forwarded.load(Ordering::SeqCst) == 0,
            )
            .await;
        let took = started.elapsed();
        let result = outcome.and_then(|result| kept(result, &self.budgets));
        match &result {
            Ok(answer) => self.logged(&placement, took, answer.bytes(), "ok"),
            Err(error) => self.logged(&placement, took, 0, error.code()),
        }
        result
    }

    /// Resolves a request into one model, one set of parameters, and the
    /// references it carries.
    ///
    /// The configuration comes from a single in-memory snapshot and the
    /// credential from the store's own cache, so the only disk access on the
    /// way to a provider is the reference media itself.
    async fn place(
        &self,
        session: &Arc<FsProjectStore>,
        request: GenerateRequest,
        cancel: &Cancel,
    ) -> Result<Placement, ProviderError> {
        cancel.check()?;
        let snapshot = self.models.snapshot().await?;
        let capability = request.capability;
        let request = merged(request, &snapshot.preferences);
        // Read after the preferences are merged, because a machine whose video
        // mode is "reference" is saying what its pictures mean.
        let scene = scene_of(&request);
        let resolved = resolve_within(&snapshot, &request.model, capability, scene)?;
        speakable(&resolved, &request)?;
        let inputs = load_inputs(
            session.as_ref(),
            &request,
            &self.budgets,
            self.audio.as_deref(),
        )
        .await?;
        let call = self.address(&resolved).await?;
        Ok(Placement {
            call,
            request,
            inputs,
        })
    }

    /// Addresses one model, fetching the credential at the moment the request
    /// goes out and not before.
    async fn address(&self, resolved: &ResolvedModel) -> Result<ModelCall, ProviderError> {
        let api_key = self.models.credential(&resolved.config_id).await?;
        ModelCall::new(resolved, api_key, self.budgets.clone())
    }

    /// Asks again after a failure waiting can fix, until the budget for
    /// attempts runs out.
    ///
    /// Shared by every kind of call, so that a generation and the start of a
    /// job cannot drift apart in how they behave under a busy provider.
    async fn retried<T, F, Fut>(
        &self,
        cancel: &Cancel,
        mut ask: F,
        again: impl Fn(&ProviderError) -> bool,
    ) -> Result<T, ProviderError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<T, ProviderError>>,
    {
        let mut attempt = 0u32;
        loop {
            cancel.check()?;
            match ask().await {
                Ok(value) => return Ok(value),
                Err(error) if again(&error) && attempt + 1 < self.budgets.max_attempts => {
                    attempt += 1;
                    // A wait that ends at once on cancellation rather than
                    // running out a backoff against a client that has gone.
                    cancel.wait(backoff(&error, attempt, &self.budgets)).await?;
                }
                Err(error) => return Err(error),
            }
        }
    }
}

/// The scenario a request is, read from the capability, the pictures it
/// carries, and the mode it asks in.
///
/// Roles rather than mime types: the media has not been loaded yet at the
/// moment a model is chosen, and the role is what the caller meant anyway. A
/// mode of "reference" says the pictures are the subject rather than the
/// frames a clip moves between, which is a scene of its own wherever frames
/// are labelled. `None` for a capability with no scenes to route.
pub fn scene_of(request: &GenerateRequest) -> Option<Scene> {
    let pictures = request.inputs.iter().any(|input| {
        matches!(
            input.role,
            InputRole::Reference | InputRole::FirstFrame | InputRole::LastFrame | InputRole::Mask
        )
    });
    match request.capability {
        Capability::Video => Some(if !pictures {
            Scene::TextToVideo
        } else if request.text_param("mode") == Some("reference") {
            Scene::ReferenceToVideo
        } else if request.inputs_in(InputRole::FirstFrame).next().is_some()
            && request.inputs_in(InputRole::LastFrame).next().is_some()
        {
            Scene::FirstLastFrame
        } else {
            Scene::ImageToVideo
        }),
        Capability::Image => Some(if pictures {
            Scene::ImageEdit
        } else {
            Scene::TextToImage
        }),
        _ => None,
    }
}

/// The parameters one request goes out with: what the caller said, over what
/// the user set globally, over what the project starts with.
///
/// Merged here rather than in an adapter so that no protocol has to know a
/// settings dialog exists, and so a parameter means the same thing whichever
/// provider answers.
fn merged(mut request: GenerateRequest, preferences: &Preferences) -> GenerateRequest {
    let capability = request.capability;
    // A global instruction frames a written answer. Speech has a direction of
    // its own below, and a persona meant for text would replace it rather than
    // join it. A request that states its own instruction is left alone: what one
    // node asked for is closer to the ask than what was set for all of them.
    if capability == Capability::Text && request.instruction().is_none() {
        let instruction = preferences.system_prompt.trim();
        if !instruction.is_empty() {
            request.system = Some(instruction.to_string());
        }
    }
    let params = &mut request.params;
    match capability {
        Capability::Text => {
            offer(params, "reasoningEffort", &preferences.reasoning_effort);
        }
        Capability::Image => {
            offer(params, "size", &preferences.image.size);
            offer(params, "quality", &preferences.image.quality);
            offer(params, "background", &preferences.image.background);
            offer_value(params, "count", preferences.image.count);
        }
        Capability::Speech => {
            offer(params, "voice", &preferences.speech.voice);
            offer(params, "format", &preferences.speech.format);
            offer(params, "instructions", &preferences.speech.instructions);
            offer_value(params, "speed", preferences.speech.speed);
            offer_value(params, "sampleRate", preferences.speech.sample_rate);
            offer_value(params, "volume", preferences.speech.volume);
            offer_value(params, "rate", preferences.speech.rate);
            offer_value(params, "pitch", preferences.speech.pitch);
        }
        Capability::Music => {
            // A score is shaped by less than a voice: the format it comes back
            // as, and whether it carries a watermark. What it is about stays
            // with the ask that made it.
            offer(params, "format", &preferences.music.format);
            offer_value(params, "watermark", preferences.music.watermark);
        }
        Capability::Video => {
            offer(params, "resolution", &preferences.video.resolution);
            offer(params, "mode", &preferences.video.mode);
            offer(params, "ratio", &preferences.video.ratio);
            offer_value(params, "seconds", preferences.video.seconds);
            offer_value(params, "generateAudio", preferences.video.generate_audio);
            offer_value(params, "watermark", preferences.video.watermark);
        }
        // Recognition has no global preferences: what a recording is read for —
        // which language, how many speakers — belongs to the clip being
        // transcribed rather than to the model, and the request states it.
        Capability::Asr => {}
    }
    request
}

/// A preference fills a gap. It never overwrites what the request said, and
/// one that says nothing is no preference at all: an empty `background` means
/// the provider's own choice rather than a background named "".
fn offer(params: &mut Map<String, Value>, key: &str, value: &str) {
    let value = value.trim();
    if value.is_empty() || params.contains_key(key) {
        return;
    }
    params.insert(key.to_string(), Value::String(value.to_string()));
}

/// The same rule for a value that is not text.
fn offer_value(params: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    if !params.contains_key(key) {
        params.insert(key.to_string(), value.into());
    }
}

/// Refuses a speech ask the converter behind it cannot make a sound for.
///
/// A converter that declares `needsVoice` has no voice of its own to fall
/// back on: asked without one, it hears back an engine error that names
/// neither the missing setting nor where it lives. A converter that declares
/// `needsReferenceAudio` copies the voice from a recording instead of naming
/// it, and its asks are refused the same way when no recording travelled.
///
/// A recording is a voice the same way a name is, so it satisfies
/// `needsVoice` too — and it is the harder of the two requirements, checked
/// first so a converter that insists on one is told about the recording
/// rather than about a name it can do without. Both refusals happen here,
/// before a credential is fetched or a provider is bothered, in the shape a
/// client repairs: which model, and what it wants.
fn speakable(resolved: &ResolvedModel, request: &GenerateRequest) -> Result<(), ProviderError> {
    if request.capability != Capability::Speech {
        return Ok(());
    }
    let features = converter_features(&resolved.protocol);
    if !features.needs_voice && !features.needs_reference_audio {
        return Ok(());
    }
    let named = request
        .params
        .get("voice")
        .and_then(Value::as_str)
        .is_some_and(|voice| !voice.trim().is_empty());
    let recorded = request.inputs_in(InputRole::Reference).next().is_some();
    if features.needs_reference_audio && !recorded {
        return Err(ProviderError::ReferenceAudioRequired {
            model: resolved.config_id.clone(),
        });
    }
    if features.needs_voice && !named && !recorded {
        return Err(ProviderError::VoiceRequired {
            model: resolved.config_id.clone(),
        });
    }
    Ok(())
}

/// What the converter behind a protocol declares about the asks it can make a
/// sound for.
///
/// A protocol with no converter on this machine — or one read before the
/// models tree was deployed — declares nothing, and the ask goes on to fail
/// the way it would have.
#[derive(Default)]
struct Features {
    needs_voice: bool,
    needs_reference_audio: bool,
}

fn converter_features(protocol: &Protocol) -> Features {
    let Some(root) = crate::converter::converter_root() else {
        return Features::default();
    };
    let registry = crate::converter::ConverterRegistry::load(root);
    let Some(entry) = registry.find(protocol.wire_name()) else {
        return Features::default();
    };
    Features {
        needs_voice: entry.features.get("needsVoice").copied().unwrap_or(false),
        needs_reference_audio: entry
            .features
            .get("needsReferenceAudio")
            .copied()
            .unwrap_or(false),
    }
}

/// One answer, in the shape everything above this module expects.
fn normalize(mut result: GenerateResult) -> GenerateResult {
    // A provider can pad an answer, and a text node holding nothing but
    // whitespace is a blank card on the canvas rather than an answer.
    result.text = result
        .text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    result
}

/// A success that carried nothing is a provider failure rather than a blank
/// answer: there is nothing to store, and handing one back would leave the
/// caller with an empty node and no reason for it.
fn settled(result: GenerateResult) -> Result<GenerateResult, ProviderError> {
    if result.is_empty() {
        return Err(ProviderError::NoOutput(
            "the answer carried no text and no media".to_string(),
        ));
    }
    Ok(result)
}

/// One answer, in the shape everything above this module expects and inside
/// the ceilings it was told to expect.
///
/// Shared by a call that waited an answer out and by a job that reported one
/// minutes later, so that the two cannot come apart in what they hand back.
/// Checked here rather than where an answer is written down because by then
/// the bytes are already in memory: a ceiling that only refuses to store is a
/// ceiling that has been passed.
fn kept(result: GenerateResult, budgets: &GenerateConfig) -> Result<GenerateResult, ProviderError> {
    let result = normalize(result);
    // Counted before the bytes because it is the cheaper question, and because
    // a node can only point at so many cards whatever those cards weigh.
    if result.items.len() > budgets.max_output_items {
        return Err(ProviderError::TooLarge(format!(
            "{} pieces came back where {} is the most one answer may carry",
            result.items.len(),
            budgets.max_output_items
        )));
    }
    let bytes = result.bytes();
    if bytes > budgets.max_output_bytes {
        return Err(ProviderError::TooLarge(format!(
            "{bytes} bytes came back where {} is the most one answer may carry",
            budgets.max_output_bytes
        )));
    }
    settled(result)
}

/// The capability of the call a request arrived through.
fn stamped(mut request: GenerateRequest, capability: Capability) -> GenerateRequest {
    request.capability = capability;
    request
}

/// Whether a failure is one that waiting can fix.
///
/// A timeout is left out on purpose even though asking again might work: it
/// already ran the whole budget for this capability, and quietly running it
/// again would double a wait the caller was told to expect. So is anything the
/// provider refused, which is wrong rather than late and would be refused
/// again verbatim.
fn waitable(error: &ProviderError) -> bool {
    matches!(
        error,
        ProviderError::RateLimited { .. } | ProviderError::Unreachable(_)
    )
}

/// How long to wait before asking again.
///
/// A provider that said when to come back is obeyed: a backoff that ignores it
/// either hammers a provider that asked for a minute, or waits a minute out
/// when it asked for a second.
fn backoff(error: &ProviderError, attempt: u32, budgets: &GenerateConfig) -> Duration {
    let asked = match error {
        ProviderError::RateLimited { retry_after, .. } => *retry_after,
        _ => None,
    };
    asked.unwrap_or_else(|| Duration::from_millis(budgets.retry_base_ms) * 2u32.pow(attempt - 1))
}

/// A sink that forwards to another and counts what it forwarded.
///
/// The count answers "has the caller seen anything yet", which is what decides
/// whether a failure may still be retried.
fn counting(sink: &DeltaSink) -> (Arc<AtomicUsize>, DeltaSink) {
    let forwarded = Arc::new(AtomicUsize::new(0));
    if !sink.is_streaming() {
        // Nobody is watching, so nothing is forwarded and a retry can repeat
        // the whole request.
        return (forwarded, DeltaSink::default());
    }
    let counted = Arc::clone(&forwarded);
    let tapped = sink.tapped(Arc::new(move |_| {
        counted.fetch_add(1, Ordering::SeqCst);
    }));
    (forwarded, tapped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn preferences() -> Preferences {
        Preferences {
            system_prompt: "  answer in one sentence  ".into(),
            reasoning_effort: "high".into(),
            image: crate::metadata::ImagePreferences {
                size: "1024x1024".into(),
                quality: "high".into(),
                background: String::new(),
                count: 2,
            },
            video: crate::metadata::VideoPreferences {
                seconds: 8,
                resolution: "1080".into(),
                generate_audio: false,
                watermark: true,
                mode: "reference".into(),
                ratio: "16:9".into(),
            },
            speech: crate::metadata::SpeechPreferences {
                voice: "nova".into(),
                format: "wav".into(),
                speed: 1.25,
                instructions: "speak slowly".into(),
                sample_rate: 24000,
                volume: 80,
                rate: 1.1,
                pitch: 1.0,
            },
            music: crate::metadata::MusicPreferences {
                format: "wav".into(),
                watermark: true,
            },
            story: crate::metadata::StoryPreferences {
                split_chars: 6_000,
                read_chars: 3_000,
            },
        }
    }

    fn request(capability: Capability, params: Value) -> GenerateRequest {
        GenerateRequest {
            capability,
            params: params.as_object().cloned().unwrap_or_default(),
            ..GenerateRequest::default()
        }
    }

    #[test]
    fn a_parameter_the_caller_set_survives_the_global_one() {
        let merged = merged(
            request(Capability::Image, json!({ "size": "512x512" })),
            &preferences(),
        );
        assert_eq!(merged.params["size"], "512x512", "the node knows better");
        assert_eq!(merged.params["quality"], "high", "the rest still applies");
        assert_eq!(merged.params["count"], 2);
    }

    #[test]
    fn a_preference_that_says_nothing_is_not_offered() {
        let merged = merged(request(Capability::Image, json!({})), &preferences());
        // An empty background means the provider's own choice; sending "" would
        // name a background called nothing.
        assert!(
            merged.params.get("background").is_none(),
            "{:?}",
            merged.params
        );
    }

    #[test]
    fn each_capability_is_given_its_own_parameters() {
        let video = merged(request(Capability::Video, json!({})), &preferences());
        assert_eq!(video.params["seconds"], 8);
        assert_eq!(video.params["resolution"], "1080");
        assert_eq!(video.params["generateAudio"], false);
        assert_eq!(video.params["watermark"], true);
        assert_eq!(video.params["mode"], "reference");
        assert_eq!(video.params["ratio"], "16:9");

        let speech = merged(request(Capability::Speech, json!({})), &preferences());
        assert_eq!(speech.params["voice"], "nova");
        assert_eq!(speech.params["format"], "wav");
        assert_eq!(speech.params["speed"], 1.25);
        assert_eq!(speech.params["instructions"], "speak slowly");
        assert_eq!(speech.params["sampleRate"], 24000);
        assert_eq!(speech.params["volume"], 80);
        assert_eq!(speech.params["rate"], 1.1);
        assert_eq!(speech.params["pitch"], 1.0);

        // A score takes the shape preferences and nothing of a voice's.
        let music = merged(request(Capability::Music, json!({})), &preferences());
        assert_eq!(music.params["format"], "wav");
        assert_eq!(music.params["watermark"], true);
        assert_eq!(music.params.len(), 2);

        let text = merged(request(Capability::Text, json!({})), &preferences());
        assert_eq!(text.params["reasoningEffort"], "high");
        assert_eq!(text.params.len(), 1, "text has one preference of its own");
    }

    #[test]
    fn a_scene_is_read_off_the_pictures_and_the_mode() {
        let with = |capability: Capability, roles: &[InputRole]| {
            let mut held = request(capability, json!({}));
            held.inputs = roles
                .iter()
                .enumerate()
                .map(|(at, role)| super::super::GenerateInput {
                    role: *role,
                    asset_id: format!("asset-{at}"),
                    window: None,
                })
                .collect();
            held
        };

        // A shot asked for from words alone, and one that opens on a picture.
        assert_eq!(
            scene_of(&with(Capability::Video, &[])),
            Some(Scene::TextToVideo)
        );
        assert_eq!(
            scene_of(&with(Capability::Video, &[InputRole::FirstFrame])),
            Some(Scene::ImageToVideo)
        );
        assert_eq!(
            scene_of(&with(
                Capability::Video,
                &[InputRole::FirstFrame, InputRole::LastFrame]
            )),
            Some(Scene::FirstLastFrame)
        );
        assert_eq!(
            scene_of(&with(Capability::Video, &[InputRole::Reference])),
            Some(Scene::ImageToVideo),
            "unlabelled pictures are frames until the mode says otherwise"
        );

        // The mode is the caller saying what its pictures mean, and it wins
        // over the positions they arrived in.
        let mut asked = with(
            Capability::Video,
            &[InputRole::FirstFrame, InputRole::Reference],
        );
        asked
            .params
            .insert("mode".to_string(), Value::String("reference".into()));
        assert_eq!(scene_of(&asked), Some(Scene::ReferenceToVideo));

        // Pictures make an image request an edit; none make it a drawing.
        assert_eq!(
            scene_of(&with(Capability::Image, &[InputRole::Reference])),
            Some(Scene::ImageEdit)
        );
        assert_eq!(
            scene_of(&with(Capability::Image, &[InputRole::Mask])),
            Some(Scene::ImageEdit)
        );
        assert_eq!(
            scene_of(&with(Capability::Image, &[])),
            Some(Scene::TextToImage)
        );

        // A capability with one shape has no scene to route.
        assert_eq!(scene_of(&with(Capability::Text, &[])), None);
    }

    #[test]
    fn a_global_instruction_frames_a_written_answer_only() {
        let text = merged(request(Capability::Text, json!({})), &preferences());
        assert_eq!(text.system.as_deref(), Some("answer in one sentence"));

        // Speech has a direction of its own, and a persona meant for text
        // would replace it rather than join it.
        let speech = merged(request(Capability::Speech, json!({})), &preferences());
        assert_eq!(speech.system, None);
        assert_eq!(speech.params["instructions"], "speak slowly");

        // A request that brought its own instruction keeps it.
        let own = merged(
            GenerateRequest {
                system: Some("be terse".into()),
                ..request(Capability::Text, json!({}))
            },
            &preferences(),
        );
        assert_eq!(own.system.as_deref(), Some("be terse"));

        // One node can state its own as a parameter, and that is an instruction
        // just the same.
        let asked = merged(
            request(
                Capability::Text,
                json!({ "instructions": "  answer in verse  " }),
            ),
            &preferences(),
        );
        assert_eq!(
            asked.system, None,
            "a global persona would replace the one this node asked for"
        );
        assert_eq!(asked.instruction(), Some("answer in verse"));
    }

    #[test]
    fn an_answer_is_trimmed_and_a_blank_one_is_dropped() {
        let padded = normalize(GenerateResult {
            text: Some("  a lantern  ".into()),
            ..Default::default()
        });
        assert_eq!(padded.text.as_deref(), Some("a lantern"));

        let blank = normalize(GenerateResult {
            text: Some("   \n ".into()),
            ..Default::default()
        });
        assert_eq!(blank.text, None);
        assert!(blank.is_empty());
    }

    #[test]
    fn a_success_that_carried_nothing_is_reported_as_no_output() {
        let error = settled(GenerateResult::default()).expect_err("there is nothing to store");
        assert_eq!(error.code(), "PROVIDER_NO_OUTPUT");
        assert!(
            !error.retryable(),
            "asking the same model again changes nothing"
        );

        let answered = settled(GenerateResult {
            text: Some("a lantern".into()),
            ..Default::default()
        })
        .expect("an answer is an answer");
        assert_eq!(answered.text.as_deref(), Some("a lantern"));
    }

    /// A piece of media of a given weight, which is all a ceiling looks at.
    fn piece(bytes: usize) -> crate::generate::GeneratedItem {
        crate::generate::GeneratedItem {
            bytes: vec![0; bytes],
            mime: "image/png".into(),
            kind: Capability::Image,
            width: None,
            height: None,
            duration_ms: None,
        }
    }

    #[test]
    fn an_answer_inside_both_ceilings_is_kept_in_the_shape_everything_expects() {
        let budgets = GenerateConfig {
            max_output_items: 2,
            max_output_bytes: 100,
            ..GenerateConfig::default()
        };
        let inside = kept(
            GenerateResult {
                text: Some("  a caption  ".into()),
                items: vec![piece(40), piece(7)],
                ..Default::default()
            },
            &budgets,
        )
        .expect("inside both ceilings");
        assert_eq!(inside.text.as_deref(), Some("a caption"), "still trimmed");
        assert_eq!(inside.items.len(), 2);

        // A ceiling does not replace the rule that an answer has to carry
        // something.
        assert_eq!(
            kept(GenerateResult::default(), &budgets)
                .expect_err("there is nothing to store")
                .code(),
            "PROVIDER_NO_OUTPUT"
        );
    }

    #[test]
    fn an_answer_with_too_many_pieces_names_the_ceiling_it_passed() {
        let budgets = GenerateConfig {
            max_output_items: 2,
            max_output_bytes: 1000,
            ..GenerateConfig::default()
        };
        let error = kept(
            GenerateResult {
                items: vec![piece(1), piece(1), piece(1)],
                ..Default::default()
            },
            &budgets,
        )
        .expect_err("a node cannot point at three cards");
        assert_eq!(error.code(), "GENERATION_OUTPUT_TOO_LARGE");
        assert!(
            !error.retryable(),
            "the same answer would come back the same size"
        );
        // Which ceiling was passed, because the remedy differs: fewer pieces
        // or a bigger budget.
        assert!(
            error
                .to_string()
                .contains("3 pieces came back where 2 is the most"),
            "{error}"
        );
    }

    #[test]
    fn an_answer_that_weighs_too_much_is_refused_before_it_is_handed_on() {
        let budgets = GenerateConfig {
            max_output_items: 16,
            max_output_bytes: 100,
            ..GenerateConfig::default()
        };
        let error = kept(
            GenerateResult {
                items: vec![piece(60), piece(60)],
                ..Default::default()
            },
            &budgets,
        )
        .expect_err("120 bytes where 100 is the most");
        assert_eq!(error.code(), "GENERATION_OUTPUT_TOO_LARGE");
        assert!(error.to_string().contains("120 bytes"), "{error}");

        // Words weigh something too: a ceiling that only counted media would
        // let a very long answer through.
        let words = kept(
            GenerateResult {
                text: Some("a".repeat(101)),
                ..Default::default()
            },
            &budgets,
        )
        .expect_err("101 bytes of text where 100 is the most");
        assert!(words.to_string().contains("101 bytes"), "{words}");
    }

    #[test]
    fn the_capability_of_the_call_wins_over_the_one_in_the_body() {
        let stamped = stamped(request(Capability::Text, json!({})), Capability::Image);
        assert_eq!(stamped.capability, Capability::Image);
    }

    #[test]
    fn only_a_busy_or_unreachable_provider_is_worth_waiting_for() {
        assert!(waitable(&ProviderError::Unreachable(
            "nothing answered".into()
        )));
        assert!(waitable(&ProviderError::RateLimited {
            detail: "slow down".into(),
            retry_after: None,
        }));
        // A timeout already ran the whole budget for this capability; running
        // it again would double a wait the caller was told to expect.
        assert!(!waitable(&ProviderError::Timeout("too slow".into())));
        // Wrong is not late: the same request would be refused the same way.
        assert!(!waitable(&ProviderError::Auth(
            "the key was rejected".into()
        )));
        assert!(!waitable(&ProviderError::Rejected(
            "the prompt was refused".into()
        )));
        assert!(!waitable(&ProviderError::NoOutput("nothing usable".into())));
        assert!(!waitable(&ProviderError::Cancelled));
    }

    #[test]
    fn a_backoff_doubles_and_a_provider_that_asked_for_a_wait_is_obeyed() {
        let budgets = GenerateConfig {
            retry_base_ms: 1000,
            ..GenerateConfig::default()
        };
        let unreachable = ProviderError::Unreachable("nothing answered".into());
        assert_eq!(backoff(&unreachable, 1, &budgets), Duration::from_secs(1));
        assert_eq!(backoff(&unreachable, 2, &budgets), Duration::from_secs(2));
        assert_eq!(backoff(&unreachable, 3, &budgets), Duration::from_secs(4));

        // A backoff that ignored this would hammer a provider that asked for a
        // minute, or wait a minute out when it asked for a second.
        let asked = ProviderError::RateLimited {
            detail: "slow down".into(),
            retry_after: Some(Duration::from_secs(45)),
        };
        assert_eq!(backoff(&asked, 1, &budgets), Duration::from_secs(45));
        assert_eq!(backoff(&asked, 3, &budgets), Duration::from_secs(45));
    }

    #[test]
    fn a_sink_nobody_is_watching_forwards_nothing_and_counts_nothing() {
        let (forwarded, watching) = counting(&DeltaSink::default());
        assert!(!watching.is_streaming());
        watching.push("dropped");
        assert_eq!(forwarded.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_watched_sink_counts_what_the_caller_has_already_seen() {
        let seen = Arc::new(std::sync::Mutex::new(String::new()));
        let collected = Arc::clone(&seen);
        let caller = DeltaSink::new(Arc::new(move |chunk: &str| {
            collected
                .lock()
                .expect("the sink is not held across a call")
                .push_str(chunk);
        }));

        let (forwarded, watching) = counting(&caller);
        assert!(watching.is_streaming());
        assert_eq!(forwarded.load(Ordering::SeqCst), 0, "nothing shown yet");
        watching.push("A ");
        watching.push("lantern.");
        assert_eq!(
            seen.lock()
                .expect("the sink is not held across a call")
                .as_str(),
            "A lantern.",
            "every piece still reached the caller"
        );
        assert_eq!(forwarded.load(Ordering::SeqCst), 2);
    }
}
