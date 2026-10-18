//! What a run says while it is going.
//!
//! Every transition a run makes is already written down and the record is the
//! truth; this is a display's shortcut to it, so words can appear as they
//! arrive rather than once the step that produced them has ended. Nothing here
//! is durable and nothing decides from it. A client that never listens, or one
//! that stops half way, loses the typewriter and nothing else.

use crate::domain::{NodeId, RunId, RunStatus};
use crate::generate::DeltaSink;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, Notify};
use tokio::time::Instant;

/// How long a burst of words waits to be sent on, and how much of one is sent
/// without waiting.
///
/// A provider answers a token at a time, and forwarding every token would ask a
/// canvas to redraw a hundred times a second for words that read the same
/// whether they arrive one by one or a line at a time.
const FLUSH_INTERVAL: Duration = Duration::from_millis(100);
const FLUSH_BYTES: usize = 1024;

/// How far behind a listener may fall before its oldest events are dropped
/// rather than held for it.
///
/// A display may lose a frame and catch up from the record. Holding events for
/// a client that stopped reading would turn one slow browser into memory this
/// process has to keep for it.
const BACKLOG: usize = 256;

/// Words that arrived since the last send.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub run_id: RunId,
    pub node_id: NodeId,
    /// The slot the words are going to land in, so a listener can show them
    /// where they will end up rather than somewhere it has to move them from.
    pub slot_id: String,
    pub text: String,
}

/// How far along one step is.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub run_id: RunId,
    pub node_id: NodeId,
    /// 0 to 1, or -1 when the step cannot say.
    pub fraction: f64,
}

/// One line an extension script wrote while it worked.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    pub run_id: RunId,
    pub node_id: NodeId,
    pub level: String,
    pub message: String,
}

/// The last thing a run says.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    pub run_id: RunId,
    pub status: RunStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One thing a run says about itself.
#[derive(Clone, Debug)]
pub enum RunEvent {
    Delta(Delta),
    Progress(Progress),
    Log(Log),
    Done(Done),
}

impl RunEvent {
    pub fn delta(run_id: RunId, node_id: NodeId, slot_id: String, text: String) -> Self {
        Self::Delta(Delta {
            run_id,
            node_id,
            slot_id,
            text,
        })
    }

    pub fn progress(run_id: RunId, node_id: NodeId, fraction: f64) -> Self {
        Self::Progress(Progress {
            run_id,
            node_id,
            fraction,
        })
    }

    pub fn log(run_id: RunId, node_id: NodeId, level: &str, message: String) -> Self {
        Self::Log(Log {
            run_id,
            node_id,
            level: level.to_string(),
            message,
        })
    }

    pub fn done(run_id: RunId, status: RunStatus, error: Option<String>) -> Self {
        Self::Done(Done {
            run_id,
            status,
            error,
        })
    }

    pub fn run_id(&self) -> &RunId {
        match self {
            Self::Delta(event) => &event.run_id,
            Self::Progress(event) => &event.run_id,
            Self::Log(event) => &event.run_id,
            Self::Done(event) => &event.run_id,
        }
    }

    pub fn is_done(&self) -> bool {
        matches!(self, Self::Done(_))
    }

    /// The kind a listener asks for and the body it is sent.
    ///
    /// Two halves rather than one value with a kind inside it, because the wire
    /// format names the kind on a line of its own.
    pub fn as_frame(&self) -> (&'static str, serde_json::Value) {
        // Fixed, small and public shapes, so there is nothing in one a
        // serializer could refuse: the fallback is unreachable, and being
        // silent about it beats panicking inside a task nobody is watching.
        match self {
            Self::Delta(event) => ("delta", serde_json::to_value(event).unwrap_or_default()),
            Self::Progress(event) => ("progress", serde_json::to_value(event).unwrap_or_default()),
            Self::Log(event) => ("log", serde_json::to_value(event).unwrap_or_default()),
            Self::Done(event) => ("done", serde_json::to_value(event).unwrap_or_default()),
        }
    }
}

/// What is known about one run somebody might be listening to.
struct Channel {
    events: broadcast::Sender<RunEvent>,
    /// The signals of the words still being held back for this run, each said
    /// once the read carrying them has gone.
    ///
    /// A run that ends while a last read is still buffered would otherwise say
    /// it was over first, and a listener stops reading at that point.
    pending: Vec<Arc<Notify>>,
}

/// The runs somebody might be listening to.
///
/// One channel per run, opened by whichever side asks first — a driver about to
/// say something, or a client about to listen — and dropped when the run ends,
/// which is how a listener learns that nothing more is coming.
#[derive(Clone, Default)]
pub struct RunEvents {
    channels: Arc<Mutex<HashMap<RunId, Channel>>>,
}

impl RunEvents {
    /// Joins a run's listeners, opening its channel when this is the first.
    pub fn follow(&self, run_id: &RunId) -> broadcast::Receiver<RunEvent> {
        self.channel(run_id).subscribe()
    }

    /// Says one thing about a run to whoever is listening.
    pub fn publish(&self, event: RunEvent) {
        let run_id = event.run_id().clone();
        // Saying it to a run nobody is watching is nothing happening, which is
        // the whole reason a display stream is not a queue.
        let _ = self.channel(&run_id).send(event);
    }

    /// Waits for the words still being held back for a run to be sent on.
    ///
    /// Called by whatever ends a run, before it says so: the last read of an
    /// answer is the one most worth hearing, and it is the one still buffered
    /// when the answer lands.
    pub async fn settle(&self, run_id: &RunId) {
        // Taken out under the lock and waited for outside it, because a wait is
        // exactly what the lock must not be held across.
        let waiting = self
            .channels
            .lock()
            .expect("the run event registry is not held across a call")
            .get_mut(run_id)
            .map(|channel| std::mem::take(&mut channel.pending))
            .unwrap_or_default();
        for signal in waiting {
            signal.notified().await;
        }
    }

    /// Ends a run's channel, which is what closes every listener joined to it.
    pub fn close(&self, run_id: &RunId) {
        self.channels
            .lock()
            .expect("the run event registry is not held across a call")
            .remove(run_id);
    }

    fn channel(&self, run_id: &RunId) -> broadcast::Sender<RunEvent> {
        self.channels
            .lock()
            .expect("the run event registry is not held across a call")
            .entry(run_id.clone())
            .or_insert_with(|| Channel {
                events: broadcast::channel(BACKLOG).0,
                pending: Vec::new(),
            })
            .events
            .clone()
    }

    /// Notes that words are about to be held back for a run, and hands back the
    /// signal that says they have gone.
    ///
    /// Noted before the first of them is held rather than after, so a run that
    /// ends at once cannot be settled past a signal nobody registered.
    fn holding(&self, run_id: &RunId) -> Arc<Notify> {
        let signal = Arc::new(Notify::new());
        self.channels
            .lock()
            .expect("the run event registry is not held across a call")
            .entry(run_id.clone())
            .or_insert_with(|| Channel {
                events: broadcast::channel(BACKLOG).0,
                pending: Vec::new(),
            })
            .pending
            .push(Arc::clone(&signal));
        signal
    }
}

/// A text step's words, sent on in reads rather than in tokens.
///
/// Comes back as the sink a generation streams into: what an adapter pushes is
/// buffered, and the buffer goes out when it is full or when the oldest word in
/// it has waited long enough, whichever happens first. A task of its own rather
/// than a timestamp in the callback, because the callback cannot wait — and a
/// piece of text with nothing after it still has to be sent, which is what
/// waiting is for.
///
/// The task ends when the sink is dropped, which is when the step's answer
/// lands, so the tail of a stream is never left behind — and a run's ending
/// waits for that tail rather than overtaking it.
pub fn streamed_words(
    events: RunEvents,
    run_id: RunId,
    node_id: NodeId,
    slot_id: String,
) -> DeltaSink {
    let (queued, mut drained) = mpsc::unbounded_channel::<String>();
    // Registered here rather than when the task ends, because the ending of a
    // run asks the registry what is still outstanding and has to be told.
    let sent = events.holding(&run_id);
    tokio::spawn(async move {
        let send = |text: String| {
            events.publish(RunEvent::delta(
                run_id.clone(),
                node_id.clone(),
                slot_id.clone(),
                text,
            ))
        };
        let mut held = String::new();
        // When the oldest word held has waited long enough to go on its own.
        // Measured from the first piece of a burst rather than the last, so a
        // stream that never pauses is still sent on at the interval and not
        // only ever a full buffer at a time.
        let mut due = Instant::now() + FLUSH_INTERVAL;
        loop {
            let wait = due.saturating_duration_since(Instant::now());
            tokio::select! {
                chunk = drained.recv() => {
                    // The sink is gone, so the answer has landed and nothing
                    // more is coming.
                    let Some(chunk) = chunk else { break };
                    if held.is_empty() {
                        due = Instant::now() + FLUSH_INTERVAL;
                    }
                    held.push_str(&chunk);
                    if held.len() >= FLUSH_BYTES {
                        send(std::mem::take(&mut held));
                    }
                }
                _ = tokio::time::sleep(wait), if !held.is_empty() => {
                    send(std::mem::take(&mut held));
                }
            }
        }
        if !held.is_empty() {
            send(held);
        }
        sent.notify_one();
    });
    DeltaSink::new(Arc::new(move |chunk: &str| {
        // A send that fails means the task has ended, and it ends only once the
        // answer has landed: from there the words belong to the record.
        let _ = queued.send(chunk.to_string());
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Everything still queued for a listener, in the order it was said.
    fn heard(listener: &mut broadcast::Receiver<RunEvent>) -> Vec<RunEvent> {
        let mut heard = Vec::new();
        while let Ok(event) = listener.try_recv() {
            heard.push(event);
        }
        heard
    }

    /// The words a listener was sent, in order.
    fn words(listener: &mut broadcast::Receiver<RunEvent>) -> Vec<String> {
        heard(listener)
            .iter()
            .map(|event| match event {
                RunEvent::Delta(delta) => delta.text.clone(),
                other => panic!("a text step says words, not {other:?}"),
            })
            .collect()
    }

    #[tokio::test]
    async fn a_listener_hears_what_a_run_says_and_stops_when_it_ends() {
        let events = RunEvents::default();
        let mut listener = events.follow(&"run-1".to_string());

        events.publish(RunEvent::progress("run-1".into(), "n-1".into(), 0.5));
        events.publish(RunEvent::delta(
            "run-1".into(),
            "n-1".into(),
            "result".into(),
            "hello".into(),
        ));
        events.publish(RunEvent::done("run-1".into(), RunStatus::Succeeded, None));
        events.close(&"run-1".to_string());

        let progress = listener.recv().await.expect("a fraction is said");
        assert_eq!(progress.run_id(), "run-1");
        assert!(matches!(progress, RunEvent::Progress(_)));
        let (name, body) = progress.as_frame();
        assert_eq!(name, "progress");
        assert_eq!(body["nodeId"], "n-1");
        assert_eq!(body["fraction"], 0.5);

        let (name, body) = listener.recv().await.expect("words are said").as_frame();
        assert_eq!(name, "delta");
        assert_eq!(body["slotId"], "result");
        assert_eq!(body["text"], "hello");

        let (name, body) = listener
            .recv()
            .await
            .expect("the ending is said")
            .as_frame();
        assert_eq!(name, "done");
        assert_eq!(body["status"], "succeeded");
        // Absent rather than null: a run that went well has nothing to say
        // about it, and a client that treats null as a failure would be wrong.
        assert!(body.get("error").is_none());

        assert!(listener.recv().await.is_err(), "nothing follows an ending");
    }

    #[tokio::test]
    async fn words_are_sent_on_in_reads_rather_than_in_tokens() {
        let events = RunEvents::default();
        let run_id = "run-words".to_string();
        let sink = streamed_words(
            events.clone(),
            run_id.clone(),
            "n-text".into(),
            "result".into(),
        );
        // Listening before anything is pushed, so nothing is missed.
        let mut listener = events.follow(&run_id);

        for _ in 0..40 {
            sink.push("word ");
        }
        // The words above are well under the size that sends a buffer on its
        // own, so what carries them out is the interval.
        tokio::time::sleep(FLUSH_INTERVAL * 3).await;
        sink.push("the last");
        drop(sink);
        tokio::time::sleep(FLUSH_INTERVAL).await;

        let sent = words(&mut listener);
        // Coalesced: forty pushes came out as one read, and the piece with
        // nothing after it was sent rather than left in a buffer.
        assert_eq!(sent.len(), 2, "{sent:?}");
        assert_eq!(sent[0], "word ".repeat(40));
        assert_eq!(sent[1], "the last");
    }

    #[tokio::test]
    async fn a_read_long_enough_is_sent_without_waiting_for_the_interval() {
        let events = RunEvents::default();
        let run_id = "run-full".to_string();
        let sink = streamed_words(
            events.clone(),
            run_id.clone(),
            "n-text".into(),
            "result".into(),
        );
        let mut listener = events.follow(&run_id);

        // Well past the size that sends a buffer on its own, and pushed fast
        // enough that the interval has not come round.
        sink.push(&"x".repeat(FLUSH_BYTES + 10));
        drop(sink);

        // Given turns rather than time: a yield costs microseconds, so an event
        // that arrives inside this loop arrived because the buffer was full and
        // not because the interval came round.
        let mut turns = 0;
        let sent = loop {
            let sent = words(&mut listener);
            if !sent.is_empty() {
                break sent;
            }
            turns += 1;
            assert!(turns < 100, "a full read waited for the interval instead");
            tokio::task::yield_now().await;
        };
        // One read carrying the whole push, and nothing after it.
        assert_eq!(sent, vec!["x".repeat(FLUSH_BYTES + 10)]);
        assert!(words(&mut listener).is_empty());
    }

    /// A listener stops reading at an ending, so the read still buffered when a
    /// step's answer lands has to go first.
    #[tokio::test]
    async fn an_ending_waits_for_the_words_still_held_back() {
        let events = RunEvents::default();
        let run_id = "run-tail".to_string();
        let sink = streamed_words(
            events.clone(),
            run_id.clone(),
            "n-text".into(),
            "result".into(),
        );
        let mut listener = events.follow(&run_id);

        // Under the size that sends a buffer on its own, and the interval has
        // not come round: this is a tail that only a wait can carry out.
        sink.push("the last words");
        drop(sink);

        events.settle(&run_id).await;
        events.publish(RunEvent::done(run_id.clone(), RunStatus::Succeeded, None));
        events.close(&run_id);

        let (name, body) = listener
            .recv()
            .await
            .expect("the tail went first")
            .as_frame();
        assert_eq!(name, "delta");
        assert_eq!(body["text"], "the last words");
        let (name, _) = listener
            .recv()
            .await
            .expect("the ending follows it")
            .as_frame();
        assert_eq!(name, "done");
    }
}
