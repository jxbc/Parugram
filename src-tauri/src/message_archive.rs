use std::collections::BTreeMap;
use std::io::{BufReader, BufWriter, Write};
use std::path::PathBuf;

use crate::models::MsgData;

pub struct MessageArchive {
    directory: PathBuf,
    user_id: Option<i64>,
    enabled: bool,
    messages: BTreeMap<(i64, i64), MsgData>,
    dirty: bool,
}

impl MessageArchive {
    pub fn new(directory: PathBuf) -> Self {
        let enabled = std::fs::read(directory.join("archive-settings.json")).ok()
            .and_then(|bytes| serde_json::from_slice::<bool>(&bytes).ok()).unwrap_or(false);
        Self { directory, user_id: None, enabled, messages: BTreeMap::new(), dirty: false }
    }

    pub fn enabled(&self) -> bool { self.enabled }

    pub fn select_user(&mut self, user_id: i64) -> Result<(), String> {
        if self.user_id == Some(user_id) { return Ok(()); }
        let flushed = self.flush();
        self.user_id = None;
        self.messages.clear();
        self.dirty = false;
        flushed?;
        let path = self.directory.join("deleted-messages").join(format!("{user_id}.json"));
        match std::fs::File::open(path) {
            Ok(file) => {
                let messages: Vec<MsgData> = serde_json::from_reader(BufReader::new(file)).map_err(|_| "Не удалось прочитать архив сообщений")?;
                for message in messages { self.messages.insert((message.chat_id, message.id), message); }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(_) => return Err("Не удалось прочитать архив сообщений".into()),
        }
        self.user_id = Some(user_id);
        Ok(())
    }

    pub fn configure(&mut self, enabled: bool) -> Result<(), String> {
        std::fs::create_dir_all(&self.directory).map_err(|_| "Не удалось сохранить настройки")?;
        write_json(&self.directory.join("archive-settings.json"), &enabled)?;
        self.enabled = enabled;
        self.dirty = true;
        self.flush()
    }

    pub fn remember(&mut self, message: MsgData) {
        if self.user_id.is_none() { return; }
        let key = (message.chat_id, message.id);
        if self.messages.get(&key).is_some_and(|existing| existing.is_deleted) { return; }
        self.messages.insert(key, message);
        if !self.enabled && self.messages.len() > 5000 {
            let oldest = self.messages.iter().filter(|(_, message)| !message.is_deleted)
                .min_by_key(|(_, message)| (message.date, message.id)).map(|(key, _)| *key);
            if let Some(key) = oldest { self.messages.remove(&key); }
        }
        if self.enabled { self.dirty = true; }
    }

    pub fn update_content(&mut self, chat_id: i64, message_id: i64, content: crate::models::MsgContent) {
        if let Some(message) = self.messages.get_mut(&(chat_id, message_id)).filter(|message| !message.is_deleted) {
            message.content = content;
            if self.enabled { self.dirty = true; }
        }
    }

    pub fn update_reactions(&mut self, chat_id: i64, message_id: i64, reactions: Vec<crate::models::ReactionData>) {
        if let Some(message) = self.messages.get_mut(&(chat_id, message_id)).filter(|message| !message.is_deleted) {
            message.reactions = reactions;
            if self.enabled { self.dirty = true; }
        }
    }

    pub fn deleted(&self, chat_id: i64) -> Vec<MsgData> {
        self.messages.values().filter(|message| message.chat_id == chat_id && message.is_deleted).cloned().collect()
    }

    pub fn find_deleted(&self, chat_id: i64, message_id: i64) -> Option<MsgData> {
        self.messages.get(&(chat_id, message_id)).filter(|message| message.is_deleted).cloned()
    }

    pub fn mark_deleted(&mut self, chat_id: i64, message_ids: &[i64]) -> Vec<MsgData> {
        let mut saved = Vec::new();
        for id in message_ids {
            let key = (chat_id, *id);
            if self.enabled {
                if let Some(message) = self.messages.get_mut(&key) {
                    message.is_deleted = true;
                    saved.push(message.clone());
                    self.dirty = true;
                }
            } else if !self.messages.get(&key).is_some_and(|message| message.is_deleted) {
                self.messages.remove(&key);
            }
        }
        saved
    }

    pub fn flush(&mut self) -> Result<(), String> {
        if !self.dirty { return Ok(()); }
        let Some(path) = self.path() else { return Ok(()); };
        std::fs::create_dir_all(path.parent().ok_or("Архив недоступен")?).map_err(|_| "Не удалось сохранить архив сообщений")?;
        let messages: Vec<_> = self.messages.values().filter(|message| self.enabled || message.is_deleted).collect();
        write_json(&path, &messages)?;
        self.dirty = false;
        Ok(())
    }

    fn path(&self) -> Option<PathBuf> { self.user_id.map(|id| self.directory.join("deleted-messages").join(format!("{id}.json"))) }
}

fn write_json(path: &std::path::Path, data: &impl serde::Serialize) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let file = std::fs::File::create(&temporary).map_err(|_| "Не удалось сохранить архив сообщений")?;
    let mut writer = BufWriter::new(file);
    serde_json::to_writer(&mut writer, data).map_err(|_| "Не удалось сохранить архив сообщений")?;
    writer.flush().and_then(|_| writer.get_ref().sync_all()).map_err(|_| "Не удалось сохранить архив сообщений")?;
    drop(writer);
    std::fs::rename(temporary, path).map_err(|_| "Не удалось сохранить архив сообщений".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory() -> PathBuf {
        let mut id = [0_u8; 8];
        getrandom::fill(&mut id).unwrap();
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("archive-test-{}", u64::from_le_bytes(id)));
        std::fs::create_dir(&path).unwrap();
        path
    }

    fn message(id: i64) -> MsgData {
        serde_json::from_value(serde_json::json!({
            "id": id, "chat_id": 10, "is_outgoing": false, "date": id,
            "sender": { "kind": "user", "id": 2, "name": "Anna", "photo": null, "photo_file_id": null },
            "content": { "kind": "Text", "data": { "text": "Saved text", "entities": [] } },
            "sending_state": "sent", "error": null
        })).unwrap()
    }

    fn cleanup(directory: &PathBuf) {
        for id in [1, 2] {
            let path = directory.join("deleted-messages").join(format!("{id}.json"));
            if path.exists() { std::fs::remove_file(path).unwrap(); }
        }
        if directory.join("deleted-messages").exists() { std::fs::remove_dir(directory.join("deleted-messages")).unwrap(); }
        if directory.join("archive-settings.json").exists() { std::fs::remove_file(directory.join("archive-settings.json")).unwrap(); }
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn retains_deleted_content_across_restart_and_ignores_stale_updates() {
        let directory = directory();
        let mut archive = MessageArchive::new(directory.clone());
        archive.select_user(1).unwrap();
        archive.configure(true).unwrap();
        archive.remember(message(20));
        archive.flush().unwrap();
        archive = MessageArchive::new(directory.clone());
        archive.select_user(1).unwrap();
        let saved = archive.mark_deleted(10, &[20, 99]);
        assert_eq!(saved.len(), 1);
        assert!(saved[0].is_deleted);
        let mut stale = message(20);
        stale.content = crate::models::MsgContent::Text { text: "stale".into(), entities: vec![] };
        archive.remember(stale.clone());
        archive.update_content(10, 20, stale.content);
        archive.flush().unwrap();
        archive = MessageArchive::new(directory.clone());
        archive.select_user(1).unwrap();
        assert_eq!(crate::td::convert::content_preview(&archive.deleted(10)[0].content), "Saved text");
        cleanup(&directory);
    }

    #[test]
    fn disabling_stops_new_saves_and_archives_are_separate_for_each_account() {
        let directory = directory();
        let mut archive = MessageArchive::new(directory.clone());
        archive.select_user(1).unwrap();
        archive.remember(message(10));
        assert!(archive.mark_deleted(10, &[10]).is_empty());
        archive.configure(true).unwrap();
        archive.remember(message(20));
        archive.mark_deleted(10, &[20]);
        archive.configure(false).unwrap();
        archive.remember(message(30));
        assert!(archive.mark_deleted(10, &[30]).is_empty());
        archive.flush().unwrap();
        archive.select_user(2).unwrap();
        assert!(archive.deleted(10).is_empty());
        archive.select_user(1).unwrap();
        assert_eq!(archive.deleted(10).len(), 1);
        assert_eq!(archive.deleted(10)[0].id, 20);
        assert!(!archive.enabled());
        cleanup(&directory);
    }
}
