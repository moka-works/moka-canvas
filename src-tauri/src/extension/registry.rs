//! The definitions installed on this machine, read from `nodes/`.
//!
//! One directory is one definition, so a read is a directory listing and a
//! parse per entry. It never fails as a whole: a directory that cannot become
//! a definition is reported beside the ones that did, because a menu that
//! silently loses an entry is harder to repair than one that says what is
//! wrong with it.

use std::path::{Path, PathBuf};

use super::manifest::{self, LoadProblem, NodeDefinition};

/// The definitions a machine has, in the order a menu reads them, and what
/// could not be read.
#[derive(Debug, Default)]
pub struct ExtensionRegistry {
    definitions: Vec<NodeDefinition>,
    problems: Vec<LoadProblem>,
}

impl ExtensionRegistry {
    /// Reads every directory under `root`. A root that does not exist yet is
    /// an empty machine, not a failure.
    pub fn load(root: &Path) -> Self {
        let mut definitions = Vec::new();
        let mut problems = Vec::new();
        let Ok(entries) = std::fs::read_dir(root) else {
            return Self::default();
        };
        let mut directories: Vec<PathBuf> = entries
            .flatten()
            .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|entry| entry.path())
            .collect();
        directories.sort();
        for dir in directories {
            let Some(id) = dir.file_name().and_then(|name| name.to_str()) else {
                problems.push(LoadProblem::new(
                    "?",
                    "EXTENSION_MANIFEST_INVALID",
                    "a definition directory has no usable name",
                ));
                continue;
            };
            if !super::valid_directory_id(id) {
                problems.push(LoadProblem::new(
                    id,
                    "EXTENSION_MANIFEST_INVALID",
                    format!("the directory name \"{id}\" is not a definition id"),
                ));
                continue;
            }
            match manifest::load(&dir, id) {
                Ok(definition) => definitions.push(definition),
                Err(problem) => problems.push(problem),
            }
        }
        definitions.sort_by(|one, two| one.order.cmp(&two.order).then_with(|| one.id.cmp(&two.id)));
        Self {
            definitions,
            problems,
        }
    }

    pub fn definitions(&self) -> &[NodeDefinition] {
        &self.definitions
    }

    pub fn problems(&self) -> &[LoadProblem] {
        &self.problems
    }

    pub fn find(&self, id: &str) -> Option<&NodeDefinition> {
        self.definitions
            .iter()
            .find(|definition| definition.id == id)
    }
}

/// Reads one definition by id, for a run that needs the one it was inserted
/// from. A missing directory is named as not installed; anything else wrong
/// with it keeps the manifest reader's own explanation.
pub fn load_one(root: &Path, id: &str) -> Result<NodeDefinition, LoadProblem> {
    if !super::valid_directory_id(id) {
        return Err(LoadProblem::new(
            id,
            "EXTENSION_NOT_INSTALLED",
            format!("\"{id}\" is not a definition id"),
        ));
    }
    let dir = root.join(id);
    if !dir.is_dir() {
        return Err(LoadProblem::new(
            id,
            "EXTENSION_NOT_INSTALLED",
            format!("the definition \"{id}\" is not installed"),
        ));
    }
    manifest::load(&dir, id).map_err(|mut problem| {
        if problem.code == "EXTENSION_MANIFEST_INVALID"
            && problem.message.contains("could not be read")
        {
            problem.code = "EXTENSION_NOT_INSTALLED".to_string();
        }
        problem
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_definition(root: &Path, id: &str, document: &str) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("node.json"), document).unwrap();
        std::fs::write(dir.join("main.lua"), "function run(ctx) end").unwrap();
    }

    fn document(order: u32) -> String {
        format!(
            r#"{{
              "apiVersion": 1,
              "displayName": "Node {order}",
              "script": "main.lua",
              "order": {order},
              "inputs": [],
              "outputs": [{{"id": "out", "dataTypes": ["text"], "label": "Text"}}],
              "models": []
            }}"#
        )
    }

    #[test]
    fn reads_each_directory_and_lists_them_in_declared_order() {
        let dir = tempfile::tempdir().unwrap();
        write_definition(dir.path(), "second", &document(20));
        write_definition(dir.path(), "first", &document(10));

        let registry = ExtensionRegistry::load(dir.path());
        let ids: Vec<&str> = registry
            .definitions()
            .iter()
            .map(|definition| definition.id.as_str())
            .collect();
        assert_eq!(ids, ["first", "second"]);
        assert!(registry.problems().is_empty());
    }

    #[test]
    fn a_broken_directory_is_reported_beside_the_ones_that_loaded() {
        let dir = tempfile::tempdir().unwrap();
        write_definition(dir.path(), "good", &document(10));
        let broken = dir.path().join("broken");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("node.json"), "{not json").unwrap();

        let registry = ExtensionRegistry::load(dir.path());
        assert!(registry.find("good").is_some());
        assert_eq!(registry.problems().len(), 1);
        assert_eq!(registry.problems()[0].id, "broken");
        assert_eq!(registry.problems()[0].code, "EXTENSION_MANIFEST_INVALID");
    }

    #[test]
    fn a_directory_that_is_not_shaped_like_a_definition_is_never_read() {
        let dir = tempfile::tempdir().unwrap();
        write_definition(dir.path(), "Hidden", &document(10));
        std::fs::create_dir_all(dir.path().join(".hidden")).unwrap();
        let registry = ExtensionRegistry::load(dir.path());
        assert!(registry.definitions().is_empty());
        assert_eq!(registry.problems().len(), 2);
    }

    #[test]
    fn a_root_that_does_not_exist_reads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let registry = ExtensionRegistry::load(&dir.path().join("nodes"));
        assert!(registry.definitions().is_empty());
        assert!(registry.problems().is_empty());
    }

    #[test]
    fn one_definition_can_be_read_by_id_and_a_missing_one_says_so() {
        let dir = tempfile::tempdir().unwrap();
        write_definition(dir.path(), "good", &document(10));
        assert_eq!(load_one(dir.path(), "good").unwrap().id, "good");
        let missing = load_one(dir.path(), "gone").unwrap_err();
        assert_eq!(missing.code, "EXTENSION_NOT_INSTALLED");
    }
}
