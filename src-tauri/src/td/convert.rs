// Конвертация сгенерированных типов tdlib-rs в модели фронтенда.
use crate::models::{ChatPositionData, ChatSummary, FileData, ForwardOrigin, MsgContent, MsgData, SenderData, TextEntityData, UserPayload};

use tdlib_rs::enums::{ChatType, MessageContent, NotificationSettingsScope};
use tdlib_rs::types::{Chat, ChatNotificationSettings, File, Message, PhotoSize};

pub fn notification_scope(chat_type: &ChatType) -> NotificationSettingsScope {
    match chat_type {
        ChatType::Supergroup(group) if group.is_channel => NotificationSettingsScope::ChannelChats,
        ChatType::Supergroup(_) | ChatType::BasicGroup(_) => NotificationSettingsScope::GroupChats,
        _ => NotificationSettingsScope::PrivateChats,
    }
}

pub fn notification_scope_key(scope: NotificationSettingsScope) -> &'static str {
    match scope {
        NotificationSettingsScope::PrivateChats => "private",
        NotificationSettingsScope::GroupChats => "group",
        NotificationSettingsScope::ChannelChats => "channel",
    }
}

pub fn notifications_muted(settings: &ChatNotificationSettings) -> Option<bool> {
    (!settings.use_default_mute_for).then_some(settings.mute_for > 0)
}

pub fn chat_to_summary(chat: &Chat) -> ChatSummary {
    let position = chat.positions.iter().find(|p| matches!(p.list, tdlib_rs::enums::ChatList::Main));
    ChatSummary {
        id: chat.id,
        title: chat.title.clone(),
        is_group: match &chat.r#type {
            tdlib_rs::enums::ChatType::BasicGroup(_) => true,
            tdlib_rs::enums::ChatType::Supergroup(group) => !group.is_channel,
            _ => false,
        },
        notification_scope: notification_scope_key(notification_scope(&chat.r#type)),
        notifications_muted: notifications_muted(&chat.notification_settings),
        photo: chat.photo.as_ref().and_then(|photo| file_to_data(&photo.small).local_path),
        photo_file_id: chat.photo.as_ref().map(|photo| photo.small.id),
        order: position.map_or(0, |p| p.order),
        is_pinned: position.map_or(false, |p| p.is_pinned),
        positions: chat.positions.iter().map(position_to_data).collect(),
        unread_count: chat.unread_count,
        unread_mention_count: chat.unread_mention_count,
        is_marked_as_unread: chat.is_marked_as_unread,
        last_read_inbox_message_id: chat.last_read_inbox_message_id,
        last_read_outbox_message_id: chat.last_read_outbox_message_id,
        last_message: chat.last_message.as_ref().map(message_to_data),
    }
}

pub fn message_to_data(message: &Message) -> MsgData {
    MsgData {
        id: message.id,
        chat_id: message.chat_id,
        is_outgoing: message.is_outgoing,
        sender: sender_to_data(&message.sender_id, &message.author_signature),
        date: message.date,
        content: content_to_data(&message.content),
        sending_state: match &message.sending_state {
            Some(tdlib_rs::enums::MessageSendingState::Pending(_)) => "pending",
            Some(tdlib_rs::enums::MessageSendingState::Failed(_)) => "failed",
            None => "sent",
        }.into(),
        error: match &message.sending_state {
            Some(tdlib_rs::enums::MessageSendingState::Failed(f)) => Some(f.error.message.clone()),
            _ => None,
        },
        forward_from: message.forward_info.as_ref().map(|forward| forward_origin(&forward.origin)),
        reply_to: message.reply_to.as_ref().map(|reply| match reply {
            tdlib_rs::enums::MessageReplyTo::Message(reply) => crate::models::ReplyData {
                chat_id: if reply.chat_id == 0 { message.chat_id } else { reply.chat_id }, message_id: reply.message_id,
                author: match &reply.origin {
                    Some(tdlib_rs::enums::MessageOrigin::HiddenUser(user)) => user.sender_name.clone(),
                    _ => String::new(),
                },
                preview: reply.content.as_ref().map(|content| content_preview(&content_to_data(content))).unwrap_or_default(),
                quote: reply.quote.as_ref().map(|quote| quote.text.text.clone()).unwrap_or_default(),
            },
            tdlib_rs::enums::MessageReplyTo::Story(_) => crate::models::ReplyData {
                chat_id: 0, message_id: 0, author: "Ответ на историю".into(), preview: "История".into(), quote: String::new(),
            },
        }),
        reactions: reactions_to_data(message.interaction_info.as_ref()),
        is_deleted: false,
        thread_id: match &message.topic_id { Some(tdlib_rs::enums::MessageTopic::Thread(topic)) => Some(topic.message_thread_id), _ => None },
        is_channel_post: message.is_channel_post,
        comment_count: message.interaction_info.as_ref().and_then(|info| info.reply_info.as_ref()).filter(|_| message.is_channel_post).map(|info| info.reply_count),
    }
}

pub fn sender_to_data(sender: &tdlib_rs::enums::MessageSender, signature: &str) -> SenderData {
    let (kind, id, name) = match sender {
        tdlib_rs::enums::MessageSender::User(user) => ("user", user.user_id, ""),
        tdlib_rs::enums::MessageSender::Chat(chat) => ("chat", chat.chat_id, signature),
    };
    SenderData { kind: kind.into(), id, name: name.into(), first_name: None, photo: None, photo_file_id: None }
}

fn forward_origin(origin: &tdlib_rs::enums::MessageOrigin) -> ForwardOrigin {
    use tdlib_rs::enums::MessageOrigin::*;
    let (kind, id, name) = match origin {
        User(origin) => ("user", Some(origin.sender_user_id), ""),
        HiddenUser(origin) => ("hidden", None, origin.sender_name.as_str()),
        Chat(origin) => ("chat", Some(origin.sender_chat_id), origin.author_signature.as_str()),
        Channel(origin) => ("chat", Some(origin.chat_id), origin.author_signature.as_str()),
    };
    ForwardOrigin { kind: kind.into(), id, name: name.into() }
}

pub fn user_to_payload(user: &tdlib_rs::types::User) -> UserPayload {
    UserPayload {
        id: user.id,
        first_name: user.first_name.clone(),
        last_name: user.last_name.clone(),
        username: user.usernames.as_ref()
            .and_then(|names| names.active_usernames.first().cloned()).unwrap_or_default(),
        photo: user.profile_photo.as_ref().and_then(|photo| file_to_data(&photo.small).local_path),
        photo_file_id: user.profile_photo.as_ref().map(|photo| photo.small.id),
    }
}

pub fn content_to_data(content: &MessageContent) -> MsgContent {
    use tdlib_rs::enums::MessageContent as C;
    match content {
        C::MessageText(m) => MsgContent::Text {
            text: m.text.text.clone(),
            entities: entities_to_data(&m.text),
        },
        C::MessageAnimatedEmoji(m) => MsgContent::Text { text: m.emoji.clone(), entities: vec![] },
        C::MessagePhoto(m) => {
            let (file_id, width, height, thumbnail_file_id) = photo_files(&m.photo.sizes);
            MsgContent::Photo {
                file_id,
                thumbnail_file_id,
                width,
                height,
                caption: m.caption.text.clone(),
                entities: entities_to_data(&m.caption),
            }
        }
        C::MessageVideo(m) => MsgContent::Video {
            file_id: m.video.video.id,
            file_name: if m.video.file_name.is_empty() {
                "video.mp4".into()
            } else {
                m.video.file_name.clone()
            },
            width: m.video.width, height: m.video.height, duration: m.video.duration,
            thumbnail_file_id: m.video.thumbnail.as_ref().map(|thumbnail| thumbnail.file.id),
            caption: m.caption.text.clone(),
            entities: entities_to_data(&m.caption),
        },
        C::MessageVideoNote(m) if !m.is_secret => MsgContent::VideoNote {
            file_id: m.video_note.video.id,
            duration: m.video_note.duration,
            thumbnail_file_id: m.video_note.thumbnail.as_ref().map(|thumbnail| thumbnail.file.id),
        },
        C::MessageVideoNote(_) => MsgContent::Unsupported { label: "Защищённый кружок недоступен".into() },
        C::MessageAnimation(m) => MsgContent::Animation {
            file_id: m.animation.animation.id,
            width: m.animation.width,
            height: m.animation.height,
            duration: m.animation.duration,
            file_name: m.animation.file_name.clone(),
            mime_type: m.animation.mime_type.clone(),
            caption: m.caption.text.clone(),
            entities: entities_to_data(&m.caption),
        },
        C::MessageDocument(m) => MsgContent::File {
            file_id: m.document.document.id,
            file_name: m.document.file_name.clone(),
            size: file_size(&m.document.document),
            caption: m.caption.text.clone(),
            entities: entities_to_data(&m.caption),
        },
        C::MessageAudio(m) => MsgContent::Audio {
            file_id: m.audio.audio.id,
            file_name: m.audio.file_name.clone(),
            size: file_size(&m.audio.audio),
            duration: m.audio.duration,
            title: m.audio.title.clone(),
            performer: m.audio.performer.clone(),
            mime_type: m.audio.mime_type.clone(),
            cover_file_id: m.audio.album_cover_thumbnail.as_ref().or_else(|| m.audio.external_album_covers.first()).map(|cover| cover.file.id),
            caption: m.caption.text.clone(),
            entities: entities_to_data(&m.caption),
        },
        C::MessageVoiceNote(m) => MsgContent::Voice {
            file_id: m.voice_note.voice.id,
            duration: m.voice_note.duration,
            waveform: m.voice_note.waveform.clone(),
            mime_type: m.voice_note.mime_type.clone(),
            caption: m.caption.text.clone(),
            entities: entities_to_data(&m.caption),
        },
        C::MessageSticker(m) => MsgContent::Sticker {
            file_id: m.sticker.sticker.id, width: m.sticker.width, height: m.sticker.height, emoji: m.sticker.emoji.clone(),
            format: match m.sticker.format {
                tdlib_rs::enums::StickerFormat::Webp => "webp",
                tdlib_rs::enums::StickerFormat::Tgs => "tgs",
                tdlib_rs::enums::StickerFormat::Webm => "webm",
            }.into(),
        },
        C::MessagePinMessage(m) => event("pin", vec![], "", m.message_id),
        C::MessageChatAddMembers(m) => event("add_members", m.member_user_ids.clone(), "", 0),
        C::MessageChatDeleteMember(m) => event("remove_member", vec![m.user_id], "", 0),
        C::MessageChatJoinByLink => event("join", vec![], "по ссылке", 0),
        C::MessageChatJoinByRequest => event("notice", vec![], "вступил по заявке", 0),
        C::MessageChatChangeTitle(m) => event("title", vec![], &m.title, 0),
        C::MessageChatChangePhoto(_) => event("photo", vec![], "", 0),
        C::MessageChatDeletePhoto => event("delete_photo", vec![], "", 0),
        C::MessageBasicGroupChatCreate(m) => event("create", vec![], &m.title, 0),
        C::MessageChatUpgradeTo(_) | C::MessageChatUpgradeFrom(_) => event("upgrade", vec![], "", 0),
        C::MessageVideoChatStarted(_) => event("video_chat", vec![], "начал видеочат", 0),
        C::MessageVideoChatEnded(_) => event("video_chat", vec![], "завершил видеочат", 0),
        C::MessageChatSetTheme(_) => event("theme", vec![], "изменил тему чата", 0),
        C::MessageChatSetMessageAutoDeleteTime(_) => event("timer", vec![], "изменил таймер удаления сообщений", 0),
        C::MessageChatSetBackground(_) => event("notice", vec![], "изменил фон чата", 0),
        C::MessageSupergroupChatCreate(m) => event("create", vec![], &m.title, 0),
        C::MessageChatBoost(m) => event("notice", vec![], &format!("добавил бусты: {}", m.boost_count), 0),
        C::MessageForumTopicCreated(m) => event("notice", vec![], &format!("создал тему «{}»", m.name), 0),
        C::MessageForumTopicEdited(m) => event("notice", vec![], &if m.name.is_empty() { "изменил значок темы".into() } else { format!("переименовал тему в «{}»", m.name) }, 0),
        C::MessageForumTopicIsClosedToggled(m) => event("notice", vec![], if m.is_closed { "закрыл тему" } else { "открыл тему" }, 0),
        C::MessageForumTopicIsHiddenToggled(m) => event("notice", vec![], if m.is_hidden { "скрыл тему" } else { "показал тему" }, 0),
        other => MsgContent::Unsupported {
            label: unsupported_label(other),
        },
    }
}

fn event(action: &str, members: Vec<i64>, text: &str, message_id: i64) -> MsgContent {
    MsgContent::Event {
        action: action.into(), text: text.into(), message_id,
        members: members.into_iter().map(|id| SenderData { kind: "user".into(), id, name: String::new(), first_name: None, photo: None, photo_file_id: None }).collect(),
    }
}

pub fn content_preview(content: &MsgContent) -> String {
    match content {
        MsgContent::Text { text, .. } => text.clone(),
        MsgContent::Photo { caption, .. } | MsgContent::Video { caption, .. } | MsgContent::Animation { caption, .. } | MsgContent::Audio { caption, .. } | MsgContent::Voice { caption, .. } if !caption.is_empty() => caption.clone(),
        MsgContent::Photo { .. } => "Фото".into(),
        MsgContent::Video { .. } => "Видео".into(),
        MsgContent::VideoNote { .. } => "Кружок".into(),
        MsgContent::Animation { .. } => "GIF".into(),
        MsgContent::Voice { .. } => "Голосовое сообщение".into(),
        MsgContent::File { file_name, .. } => file_name.clone(),
        MsgContent::Audio { title, file_name, .. } => if title.is_empty() { file_name.clone() } else { title.clone() },
        MsgContent::Sticker { emoji, .. } => format!("{emoji} Стикер"),
        MsgContent::Event { .. } => "Событие чата".into(),
        MsgContent::Unsupported { label } => label.clone(),
    }
}

pub fn reaction_to_data(reaction: &tdlib_rs::enums::ReactionType) -> crate::models::ReactionData {
    use tdlib_rs::enums::ReactionType as R;
    let (key, emoji, custom_emoji_id) = match reaction {
        R::Emoji(emoji) => (format!("emoji:{}", emoji.emoji), emoji.emoji.clone(), None),
        R::CustomEmoji(emoji) => (format!("custom:{}", emoji.custom_emoji_id), String::new(), Some(emoji.custom_emoji_id.to_string())),
        R::Paid => ("paid".into(), "⭐".into(), None),
    };
    crate::models::ReactionData { key, emoji, custom_emoji_id, count: 0, chosen: false, needs_premium: false, recent_senders: Vec::new(), can_list_senders: false }
}

pub fn sticker_to_data(sticker: &tdlib_rs::types::Sticker) -> crate::models::StickerData {
    crate::models::StickerData {
        file_id: sticker.sticker.id, set_id: sticker.set_id.to_string(), width: sticker.width, height: sticker.height,
        emoji: sticker.emoji.clone(), thumbnail_file_id: sticker.thumbnail.as_ref().map(|thumbnail| thumbnail.file.id),
        format: match sticker.format {
            tdlib_rs::enums::StickerFormat::Webp => "webp",
            tdlib_rs::enums::StickerFormat::Tgs => "tgs",
            tdlib_rs::enums::StickerFormat::Webm => "webm",
        }.into(),
    }
}

pub fn reactions_to_data(info: Option<&tdlib_rs::types::MessageInteractionInfo>) -> Vec<crate::models::ReactionData> {
    info.and_then(|info| info.reactions.as_ref()).map(|reactions| reactions.reactions.iter().map(|reaction| {
        let mut data = reaction_to_data(&reaction.r#type);
        data.count = reaction.total_count;
        data.chosen = reaction.is_chosen;
        data.can_list_senders = reactions.can_get_added_reactions && data.key != "paid";
        if data.key != "paid" && (1..=3).contains(&data.count) {
            for sender in reaction.recent_sender_ids.iter().chain(reaction.used_sender_id.iter()) {
                let sender = sender_to_data(sender, "");
                if sender.id != 0 && !data.recent_senders.iter().any(|item| item.kind == sender.kind && item.id == sender.id) {
                    data.recent_senders.push(sender);
                }
                if data.recent_senders.len() == data.count as usize { break; }
            }
        }
        data
    }).collect()).unwrap_or_default()
}

pub fn folder_id(list: &tdlib_rs::enums::ChatList) -> i32 {
    match list {
        tdlib_rs::enums::ChatList::Main => 0,
        tdlib_rs::enums::ChatList::Archive => -1,
        tdlib_rs::enums::ChatList::Folder(folder) => folder.chat_folder_id,
    }
}

pub fn chat_action_name(action: &tdlib_rs::enums::ChatAction) -> &'static str {
    use tdlib_rs::enums::ChatAction as A;
    match action {
        A::Typing => "typing",
        A::RecordingVideo => "recording_video",
        A::UploadingVideo(_) => "uploading_video",
        A::RecordingVoiceNote => "recording_voice",
        A::UploadingVoiceNote(_) => "uploading_voice",
        A::UploadingPhoto(_) => "uploading_photo",
        A::UploadingDocument(_) => "uploading_file",
        A::ChoosingSticker => "choosing_sticker",
        A::ChoosingLocation => "choosing_location",
        A::ChoosingContact => "choosing_contact",
        A::StartPlayingGame => "playing_game",
        A::RecordingVideoNote => "recording_video_note",
        A::UploadingVideoNote(_) => "uploading_video_note",
        A::WatchingAnimations(_) => "watching_animation",
        A::Cancel => "cancel",
    }
}

pub fn chat_list(folder_id: i32) -> tdlib_rs::enums::ChatList {
    match folder_id {
        0 => tdlib_rs::enums::ChatList::Main,
        -1 => tdlib_rs::enums::ChatList::Archive,
        id => tdlib_rs::enums::ChatList::Folder(tdlib_rs::types::ChatListFolder { chat_folder_id: id }),
    }
}

pub fn position_to_data(position: &tdlib_rs::types::ChatPosition) -> ChatPositionData {
    ChatPositionData {
        folder_id: folder_id(&position.list),
        order: position.order,
        is_pinned: position.is_pinned,
    }
}

pub fn entities_to_data(text: &tdlib_rs::types::FormattedText) -> Vec<TextEntityData> {
    use tdlib_rs::enums::TextEntityType as T;
    text.entities.iter().filter_map(|entity| {
        let (kind, value, user_id) = match &entity.r#type {
            T::Mention => ("mention", String::new(), None),
            T::MentionName(mention) => ("user", String::new(), Some(mention.user_id)),
            T::Url => ("url", String::new(), None),
            T::TextUrl(link) => ("url", link.url.clone(), None),
            T::Bold => ("bold", String::new(), None),
            T::Italic => ("italic", String::new(), None),
            T::Underline => ("underline", String::new(), None),
            T::Strikethrough => ("strikethrough", String::new(), None),
            T::Spoiler => ("spoiler", String::new(), None),
            T::Code => ("code", String::new(), None),
            T::Pre => ("pre", String::new(), None),
            T::PreCode(code) => ("pre", code.language.clone(), None),
            T::BlockQuote => ("quote", String::new(), None),
            T::ExpandableBlockQuote => ("expandable_quote", String::new(), None),
            _ => return None,
        };
        Some(TextEntityData {
            offset: entity.offset, length: entity.length, kind: kind.into(), value, user_id,
        })
    }).collect()
}

fn file_size(file: &File) -> i64 {
    if file.size > 0 {
        file.size
    } else {
        file.expected_size
    }
}

fn photo_files(sizes: &[PhotoSize]) -> (i32, i32, i32, Option<i32>) {
    let valid = sizes.iter().filter(|size| size.width > 0 && size.height > 0 && size.photo.id > 0);
    let area = |size: &&PhotoSize| i64::from(size.width) * i64::from(size.height);
    let Some(original) = valid.clone().max_by_key(area) else { return (0, 0, 0, None); };
    let thumbnail = valid.filter(|size| size.width.max(size.height) <= 1280).max_by_key(area)
        .map(|size| size.photo.id);
    (original.photo.id, original.width, original.height, thumbnail)
}

fn unsupported_label(content: &MessageContent) -> String {
    use tdlib_rs::enums::MessageContent as C;
    let label = match content {
        C::MessageSticker(_) => "Стикер",
        C::MessageAnimation(_) => "GIF",
        C::MessageContact(_) => "Контакт",
        C::MessageLocation(_) => "Геолокация",
        C::MessagePoll(_) => "Опрос",
        C::MessageInvoice(_) => "Счёт",
        C::MessageCall(_) => "Звонок",
        C::MessagePinMessage(_) => "Закреплённое сообщение",
        C::MessageChatDeleteMember(_) => "Участник покинул чат",
        C::MessageChatAddMembers(_) => "Добавлен участник",
        C::MessageChatJoinByLink => "Присоединился по ссылке",
        C::MessageChatChangeTitle(_) => "Название изменено",
        C::MessageBasicGroupChatCreate(_) => "Группа создана",
        C::MessageVideoChatStarted(_) => "Видеочат начат",
        C::MessageVideoChatScheduled(_) => "Видеочат запланирован",
        _ => "Сообщение не поддерживается",
    };
    label.to_string()
}

pub fn file_to_data(file: &File) -> FileData {
    let local_path = if file.local.is_downloading_completed && !file.local.path.is_empty() {
        Some(file.local.path.clone())
    } else {
        None
    };
    FileData {
        file_id: file.id,
        local_path,
        downloaded: file.local.downloaded_prefix_size,
        size: file_size(file),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_a_bounded_photo_preview_and_keeps_the_largest_file_for_viewing() {
        let size = |id, width, height| PhotoSize {
            photo: File { id, ..Default::default() }, width, height, ..Default::default()
        };
        let sizes = [
            size(1, 4000, 3000),
            size(2, 160, 120),
            size(3, 480, 640),
            size(4, 640, 960),
            size(0, 1280, 1280),
        ];
        assert_eq!(photo_files(&sizes), (1, 4000, 3000, Some(4)));
        assert_eq!(photo_files(&sizes[..1]), (1, 4000, 3000, None));
        assert_eq!(photo_files(&sizes[1..2]), (2, 160, 120, Some(2)));
        assert_eq!(photo_files(&[size(6, 1080, 2400), size(7, 144, 320), size(8, 576, 1280)]), (6, 1080, 2400, Some(8)));
        assert_eq!(photo_files(&[]), (0, 0, 0, None));
    }

    #[test]
    fn maps_forwarded_authors_without_linking_hidden_users() {
        use tdlib_rs::{enums::MessageOrigin as Origin, types};
        let origins = [
            (Origin::User(types::MessageOriginUser { sender_user_id: 7 }), "user", Some(7), ""),
            (Origin::HiddenUser(types::MessageOriginHiddenUser { sender_name: "Анна".into() }), "hidden", None, "Анна"),
            (Origin::Chat(types::MessageOriginChat { sender_chat_id: -8, author_signature: "Админ".into() }), "chat", Some(-8), "Админ"),
            (Origin::Channel(types::MessageOriginChannel { chat_id: -9, message_id: 10, author_signature: String::new() }), "chat", Some(-9), ""),
        ];
        for (origin, kind, id, name) in origins {
            let data = forward_origin(&origin);
            assert_eq!((data.kind.as_str(), data.id, data.name.as_str()), (kind, id, name));
        }
    }

    #[test]
    fn displays_standalone_animated_emoji_as_unicode_text() {
        let content = MessageContent::MessageAnimatedEmoji(tdlib_rs::types::MessageAnimatedEmoji {
            emoji: "❤️".into(),
            animated_emoji: tdlib_rs::types::AnimatedEmoji {
                sticker: None, sticker_width: 0, sticker_height: 0, fitzpatrick_type: 0, sound: None,
            },
        });
        assert!(matches!(content_to_data(&content), MsgContent::Text { text, entities } if text == "❤️" && entities.is_empty()));
    }

    #[test]
    fn maps_sticker_formats_thumbnails_and_exact_set_identifiers() {
        for (format, name) in [(tdlib_rs::enums::StickerFormat::Webp, "webp"), (tdlib_rs::enums::StickerFormat::Tgs, "tgs"), (tdlib_rs::enums::StickerFormat::Webm, "webm")] {
            let sticker = tdlib_rs::types::Sticker {
                id: 5, set_id: 9007199254740999, width: 512, height: 512, emoji: "🙂".into(), format,
                full_type: tdlib_rs::enums::StickerFullType::Regular(tdlib_rs::types::StickerFullTypeRegular::default()),
                thumbnail: Some(tdlib_rs::types::Thumbnail { format: tdlib_rs::enums::ThumbnailFormat::Webp, width: 100, height: 100, file: File { id: 43, ..Default::default() } }),
                sticker: File { id: 42, ..Default::default() },
            };
            let data = sticker_to_data(&sticker);
            assert_eq!(data.set_id, "9007199254740999");
            assert_eq!(data.file_id, 42);
            assert_eq!(data.thumbnail_file_id, Some(43));
            assert_eq!(data.format, name);
        }
    }

    #[test]
    fn maps_reaction_counts_and_selection_without_losing_custom_emoji_ids() {
        use tdlib_rs::{enums::MessageSender, types::{MessageReaction, MessageSenderChat, MessageSenderUser}};
        let emoji = tdlib_rs::enums::ReactionType::CustomEmoji(tdlib_rs::types::ReactionTypeCustomEmoji { custom_emoji_id: 9007199254740999 });
        let user = MessageSender::User(MessageSenderUser { user_id: 17 });
        let chat = MessageSender::Chat(MessageSenderChat { chat_id: -19 });
        let reaction = MessageReaction { r#type: emoji, total_count: 4, is_chosen: true, used_sender_id: Some(user.clone()), recent_sender_ids: vec![chat, user] };
        let info = tdlib_rs::types::MessageInteractionInfo {
            reactions: Some(tdlib_rs::types::MessageReactions {
                reactions: vec![reaction.clone(), MessageReaction { total_count: 2, ..reaction }],
                can_get_added_reactions: true,
                ..Default::default()
            }), ..Default::default()
        };
        let reactions = reactions_to_data(Some(&info));
        assert_eq!(reactions[0].custom_emoji_id.as_deref(), Some("9007199254740999"));
        assert_eq!(reactions[0].count, 4);
        assert!(reactions[0].chosen);
        assert!(reactions[0].recent_senders.is_empty());
        assert!(reactions[0].can_list_senders);
        assert_eq!(reactions[1].recent_senders.iter().map(|sender| (sender.kind.as_str(), sender.id)).collect::<Vec<_>>(), [("chat", -19), ("user", 17)]);
        assert!(reactions_to_data(None).is_empty());
    }

    #[test]
    fn distinguishes_pin_and_membership_notices_from_regular_messages() {
        let pin = content_to_data(&MessageContent::MessagePinMessage(tdlib_rs::types::MessagePinMessage { message_id: 42 }));
        assert!(matches!(pin, MsgContent::Event { action, message_id: 42, .. } if action == "pin"));
        let members = content_to_data(&MessageContent::MessageChatAddMembers(tdlib_rs::types::MessageChatAddMembers { member_user_ids: vec![2, 3] }));
        assert!(matches!(members, MsgContent::Event { action, members, .. } if action == "add_members" && members.iter().map(|member| member.id).collect::<Vec<_>>() == vec![2, 3]));
    }

    #[test]
    fn keeps_voice_notes_playable_with_duration_and_waveform() {
        let content = tdlib_rs::enums::MessageContent::MessageVoiceNote(tdlib_rs::types::MessageVoiceNote {
            voice_note: tdlib_rs::types::VoiceNote {
                duration: 12, waveform: "wave".into(), mime_type: "audio/ogg".into(),
                voice: tdlib_rs::types::File { id: 42, ..Default::default() }, ..Default::default()
            }, ..Default::default()
        });
        match content_to_data(&content) {
            MsgContent::Voice { file_id, duration, waveform, .. } => {
                assert_eq!(file_id, 42);
                assert_eq!(duration, 12);
                assert_eq!(waveform, "wave");
            }
            _ => panic!("expected voice note"),
        }
    }

    #[test]
    fn preserves_profile_mentions_and_utf16_offsets() {
        let text = tdlib_rs::types::FormattedText {
            text: "😀 Alice".into(),
            entities: vec![tdlib_rs::types::TextEntity {
                offset: 3, length: 5,
                r#type: tdlib_rs::enums::TextEntityType::MentionName(tdlib_rs::types::TextEntityTypeMentionName { user_id: 42 }),
            }],
        };
        let entities = entities_to_data(&text);
        assert_eq!(entities[0].offset, 3);
        assert_eq!(entities[0].user_id, Some(42));
        assert_eq!(entities[0].kind, "user");
    }

    #[test]
    fn maps_regular_video_notes_and_keeps_protected_notes_unavailable() {
        let mut note = tdlib_rs::types::MessageVideoNote {
            video_note: tdlib_rs::types::VideoNote {
                video: tdlib_rs::types::File { id: 73, ..Default::default() },
                duration: 16,
                length: 240,
                waveform: String::new(),
                minithumbnail: None,
                speech_recognition_result: None,
                thumbnail: Some(tdlib_rs::types::Thumbnail {
                    format: tdlib_rs::enums::ThumbnailFormat::Jpeg,
                    width: 90,
                    height: 90,
                    file: tdlib_rs::types::File { id: 74, ..Default::default() },
                }),
            },
            is_viewed: false,
            is_secret: false,
        };
        let data = content_to_data(&tdlib_rs::enums::MessageContent::MessageVideoNote(note.clone()));
        assert!(matches!(data, MsgContent::VideoNote { file_id: 73, duration: 16, thumbnail_file_id: Some(74) }));
        assert_eq!(content_preview(&data), "Кружок");

        note.is_secret = true;
        let data = content_to_data(&tdlib_rs::enums::MessageContent::MessageVideoNote(note));
        assert!(matches!(data, MsgContent::Unsupported { .. }));
    }

    #[test]
    fn preserves_video_dimensions_and_thumbnail_for_the_viewer() {
        let content = tdlib_rs::enums::MessageContent::MessageVideo(tdlib_rs::types::MessageVideo {
            video: tdlib_rs::types::Video {
                duration: 15, width: 640, height: 360, file_name: "clip.mp4".into(), mime_type: "video/mp4".into(),
                has_stickers: false, supports_streaming: true, minithumbnail: None,
                thumbnail: Some(tdlib_rs::types::Thumbnail { format: tdlib_rs::enums::ThumbnailFormat::Jpeg, width: 160, height: 90, file: File { id: 43, ..Default::default() } }),
                video: File { id: 42, ..Default::default() },
            },
            caption: tdlib_rs::types::FormattedText { text: "Caption".into(), entities: vec![] },
            alternative_videos: vec![], storyboards: vec![], cover: None, start_timestamp: 0,
            show_caption_above_media: false, has_spoiler: false, is_secret: false,
        });
        match content_to_data(&content) {
            MsgContent::Video { file_id, width, height, duration, thumbnail_file_id, caption, .. } => {
                assert_eq!((file_id, width, height, duration, thumbnail_file_id), (42, 640, 360, 15, Some(43)));
                assert_eq!(caption, "Caption");
            }
            _ => panic!("expected video"),
        }
    }

    #[test]
    fn preserves_telegram_animation_format_and_caption() {
        let content = tdlib_rs::enums::MessageContent::MessageAnimation(tdlib_rs::types::MessageAnimation {
            animation: tdlib_rs::types::Animation {
                duration: 3, width: 320, height: 240, file_name: "animation.mp4".into(), mime_type: "video/mp4".into(),
                has_stickers: false, minithumbnail: None, thumbnail: None, animation: File { id: 44, ..Default::default() },
            },
            caption: tdlib_rs::types::FormattedText { text: "GIF caption".into(), entities: vec![] },
            show_caption_above_media: false, has_spoiler: false, is_secret: false,
        });
        let data = content_to_data(&content);
        assert!(matches!(&data, MsgContent::Animation { file_id: 44, width: 320, height: 240, mime_type, caption, .. } if mime_type == "video/mp4" && caption == "GIF caption"));
        assert_eq!(content_preview(&data), "GIF caption");
    }

    #[test]
    fn preserves_music_metadata_and_album_cover() {
        let content = tdlib_rs::enums::MessageContent::MessageAudio(tdlib_rs::types::MessageAudio {
            audio: tdlib_rs::types::Audio {
                duration: 220, title: "Song".into(), performer: "Artist".into(), file_name: "song.mp3".into(), mime_type: "audio/mpeg".into(),
                album_cover_minithumbnail: None,
                album_cover_thumbnail: Some(tdlib_rs::types::Thumbnail { format: tdlib_rs::enums::ThumbnailFormat::Jpeg, width: 100, height: 100, file: File { id: 45, ..Default::default() } }),
                external_album_covers: vec![], audio: File { id: 44, ..Default::default() },
            },
            caption: tdlib_rs::types::FormattedText { text: String::new(), entities: vec![] },
        });
        let data = content_to_data(&content);
        assert!(matches!(&data, MsgContent::Audio { file_id: 44, duration: 220, cover_file_id: Some(45), title, performer, .. } if title == "Song" && performer == "Artist"));
        assert_eq!(content_preview(&data), "Song");
    }
}
