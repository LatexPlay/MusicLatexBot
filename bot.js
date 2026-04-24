const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const mm = require('music-metadata');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN || '8735781048:AAFVC3jH5tkjTxYXsswZ42Op858mjXrWKfU';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rdwrkvsdcudzttnywuai.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_YsoKq4O182TiMVR-AGj8lQ_7XflhXBh';
const SITE_URL = process.env.SITE_URL || 'https://latexplay.github.io/LatexPlay/index.html';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log('🎵 LatexPlay Bot started');

// ─── HELPERS ────────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function getTelegramPhotoUrl(bot, userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (photos.total_count === 0) return null;
    const fileId = photos.photos[0][0].file_id;
    const file = await bot.getFile(fileId);
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  } catch {
    return null;
  }
}

async function getOrCreateProfile(telegramUser) {
  const avatarUrl = await getTelegramPhotoUrl(bot, telegramUser.id);

  // Check existing
  const { data: existing } = await sb
    .from('profiles')
    .select('*')
    .eq('telegram_id', telegramUser.id)
    .single();

  if (existing) {
    // Update avatar if changed
    if (avatarUrl && avatarUrl !== existing.avatar_url) {
      await sb.from('profiles').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() }).eq('id', existing.id);
      existing.avatar_url = avatarUrl;
    }
    return existing;
  }

  // Create new
  const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ');
  const { data: newProfile } = await sb.from('profiles').insert({
    telegram_id: telegramUser.id,
    username: telegramUser.username || null,
    display_name: displayName,
    avatar_url: avatarUrl,
  }).select().single();

  return newProfile;
}

// ─── /start ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  await getOrCreateProfile(user);

  const welcome = `🎵 *Добро пожаловать в LatexPlay!*

Это бот для загрузки музыки на платформу [LatexPlay](${SITE_URL}).

*Что умеет бот:*
• 🔗 /connect — получить код для входа на сайт
• 🎵 Отправь MP3 файл — он появится на платформе
• 📋 /mytracks — список твоих треков
• ❌ /delete — удалить трек
• ℹ️ /help — помощь

Начни с /connect чтобы привязать аккаунт к сайту!`;

  await bot.sendMessage(chatId, welcome, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
  });
});

// ─── /connect ───────────────────────────────────────────────────────────────
bot.onText(/\/connect/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  try {
    const avatarUrl = await getTelegramPhotoUrl(bot, user.id);
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const code = generateCode();

    // Delete old codes for this user
    await sb.from('auth_codes').delete().eq('telegram_id', user.id).eq('used', false);

    // Insert new code
    await sb.from('auth_codes').insert({
      code,
      telegram_id: user.id,
      telegram_username: user.username || null,
      display_name: displayName,
      avatar_url: avatarUrl,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    await bot.sendMessage(chatId,
      `🔑 *Твой код для входа:*\n\n\`${code}\`\n\n` +
      `Введи его на [сайте](${SITE_URL}/app.html) в поле авторизации.\n\n` +
      `⏳ Код действителен *10 минут*`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('connect error:', err);
    await bot.sendMessage(chatId, '❌ Ошибка при создании кода. Попробуй снова.');
  }
});

// ─── /help ──────────────────────────────────────────────────────────────────
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId,
    `ℹ️ *Справка LatexPlay Bot*\n\n` +
    `*/start* — приветствие\n` +
    `*/connect* — получить код для входа на сайт\n` +
    `*/mytracks* — посмотреть свои загруженные треки\n` +
    `*/delete* — удалить трек по номеру из списка\n\n` +
    `*Загрузка музыки:*\nПросто отправь боту MP3 файл. Бот автоматически прочитает теги (название, исполнитель, жанр, обложка) и загрузит трек на платформу.\n\n` +
    `*Сайт:* ${SITE_URL}`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

// ─── /mytracks ──────────────────────────────────────────────────────────────
bot.onText(/\/mytracks/, async (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  const { data: profile } = await sb.from('profiles').select('id').eq('telegram_id', user.id).single();
  if (!profile) {
    return bot.sendMessage(chatId, '❌ Аккаунт не найден. Используй /connect для привязки.');
  }

  const { data: tracks } = await sb.from('tracks').select('id, title, artist, genre, duration, play_count, created_at')
    .eq('uploaded_by', profile.id)
    .order('created_at', { ascending: false });

  if (!tracks || tracks.length === 0) {
    return bot.sendMessage(chatId, '🎵 У тебя пока нет загруженных треков.\n\nОтправь мне MP3 файл!');
  }

  let text = `🎵 *Твои треки (${tracks.length}):*\n\n`;
  tracks.forEach((t, i) => {
    text += `${i + 1}. *${t.title}*`;
    if (t.artist) text += ` — ${t.artist}`;
    if (t.genre) text += ` \`[${t.genre}]\``;
    text += `\n   ▶️ ${t.play_count || 0} прослушиваний · ${formatDuration(t.duration)}\n\n`;
  });

  text += `\nДля удаления: /delete \`номер\`\nПример: /delete \`1\``;

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// ─── /delete ────────────────────────────────────────────────────────────────
bot.onText(/\/delete(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const user = msg.from;
  const num = match[1] ? parseInt(match[1]) : null;

  if (!num) {
    return bot.sendMessage(chatId, 'Укажи номер трека: /delete `1`\n\nПосмотреть список: /mytracks', { parse_mode: 'Markdown' });
  }

  const { data: profile } = await sb.from('profiles').select('id').eq('telegram_id', user.id).single();
  if (!profile) return bot.sendMessage(chatId, '❌ Аккаунт не найден.');

  const { data: tracks } = await sb.from('tracks').select('id, title')
    .eq('uploaded_by', profile.id)
    .order('created_at', { ascending: false });

  if (!tracks || tracks.length === 0) return bot.sendMessage(chatId, '🎵 Нет треков для удаления.');

  const track = tracks[num - 1];
  if (!track) return bot.sendMessage(chatId, `❌ Трека с номером ${num} нет. У тебя ${tracks.length} треков.`);

  // Delete from storage
  try {
    const fileKey = track.id + '.mp3';
    await sb.storage.from('tracks').remove([fileKey]);
  } catch {}

  // Delete from DB
  await sb.from('tracks').delete().eq('id', track.id);

  await bot.sendMessage(chatId, `✅ Трек *${track.title}* удалён.`, { parse_mode: 'Markdown' });
});

// ─── MP3 UPLOAD ─────────────────────────────────────────────────────────────
bot.on('audio', handleAudio);
bot.on('document', async (msg) => {
  if (msg.document && (msg.document.mime_type === 'audio/mpeg' || msg.document.file_name?.endsWith('.mp3'))) {
    await handleAudio(msg, true);
  } else {
    await bot.sendMessage(msg.chat.id, '❌ Отправь MP3 файл чтобы загрузить трек.');
  }
});

async function handleAudio(msg, isDocument = false) {
  const chatId = msg.chat.id;
  const user = msg.from;

  // Get or create profile
  const profile = await getOrCreateProfile(user);
  if (!profile) {
    return bot.sendMessage(chatId, '❌ Ошибка профиля. Попробуй /start');
  }

  const statusMsg = await bot.sendMessage(chatId, '⏳ Загружаю трек...');

  try {
    const fileObj = isDocument ? msg.document : msg.audio;
    const fileId = fileObj.file_id;
    const fileSize = fileObj.file_size;

    // 50MB limit
    if (fileSize > 50 * 1024 * 1024) {
      await bot.editMessageText('❌ Файл слишком большой. Максимум 50MB.', { chat_id: chatId, message_id: statusMsg.message_id });
      return;
    }

    // Download file
    await bot.editMessageText('⏳ Скачиваю файл...', { chat_id: chatId, message_id: statusMsg.message_id });
    const fileLink = await bot.getFileLink(fileId);
    const fileResp = await fetch(fileLink);
    const fileBuffer = Buffer.from(await fileResp.arrayBuffer());

    // Parse metadata
    await bot.editMessageText('🔍 Читаю теги...', { chat_id: chatId, message_id: statusMsg.message_id });

    let title = 'Unknown Track';
    let artist = null;
    let album = null;
    let genre = null;
    let duration = null;
    let coverBuffer = null;
    let coverMime = null;

    try {
      const metadata = await mm.parseBuffer(fileBuffer, 'audio/mpeg');
      const tags = metadata.common;
      const info = metadata.format;

      if (tags.title) title = tags.title;
      else if (msg.audio?.title) title = msg.audio.title;
      else if (fileObj.file_name) title = fileObj.file_name.replace(/\.mp3$/i, '');

      if (tags.artist) artist = tags.artist;
      else if (msg.audio?.performer) artist = msg.audio.performer;

      album = tags.album || null;
      genre = tags.genre?.[0] || null;
      duration = info.duration ? Math.round(info.duration) : (msg.audio?.duration || null);

      // Cover image
      if (tags.picture && tags.picture.length > 0) {
        coverBuffer = Buffer.from(tags.picture[0].data);
        coverMime = tags.picture[0].format || 'image/jpeg';
      }
    } catch (metaErr) {
      console.warn('Metadata parse failed:', metaErr.message);
      title = msg.audio?.title || fileObj.file_name?.replace(/\.mp3$/i, '') || 'Unknown Track';
      artist = msg.audio?.performer || null;
      duration = msg.audio?.duration || null;
    }

    // Upload audio to Supabase Storage
    await bot.editMessageText('📤 Загружаю на сервер...', { chat_id: chatId, message_id: statusMsg.message_id });

    const trackId = crypto.randomUUID ? crypto.randomUUID() : require('crypto').randomUUID();
    const audioPath = `${trackId}.mp3`;

    const { error: uploadErr } = await sb.storage
      .from('tracks')
      .upload(audioPath, fileBuffer, { contentType: 'audio/mpeg', upsert: false });

    if (uploadErr) {
      console.error('Upload error:', uploadErr);
      await bot.editMessageText('❌ Ошибка загрузки файла: ' + uploadErr.message, { chat_id: chatId, message_id: statusMsg.message_id });
      return;
    }

    const { data: publicUrl } = sb.storage.from('tracks').getPublicUrl(audioPath);
    const fileUrl = publicUrl.publicUrl;

    // Upload cover if exists
    let coverUrl = null;
    if (coverBuffer) {
      try {
        const coverExt = coverMime.includes('png') ? 'png' : 'jpg';
        const coverPath = `covers/${trackId}.${coverExt}`;
        await sb.storage.from('tracks').upload(coverPath, coverBuffer, { contentType: coverMime, upsert: false });
        const { data: coverPub } = sb.storage.from('tracks').getPublicUrl(coverPath);
        coverUrl = coverPub.publicUrl;
      } catch (coverErr) {
        console.warn('Cover upload failed:', coverErr.message);
      }
    }

    // Save to DB
    const { data: newTrack, error: dbErr } = await sb.from('tracks').insert({
      id: trackId,
      title,
      artist,
      album,
      genre,
      duration,
      file_url: fileUrl,
      cover_url: coverUrl,
      uploaded_by: profile.id,
      play_count: 0,
    }).select().single();

    if (dbErr) {
      console.error('DB error:', dbErr);
      await bot.editMessageText('❌ Ошибка сохранения: ' + dbErr.message, { chat_id: chatId, message_id: statusMsg.message_id });
      return;
    }

    // Update genre preferences
    if (genre && profile.id) {
      try {
        const genreKey = genre.toLowerCase();
        const { data: existing } = await sb.from('genre_preferences')
          .select('*').eq('profile_id', profile.id).eq('genre', genreKey).single();

        if (existing) {
          await sb.from('genre_preferences').update({ score: existing.score + 5, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
        } else {
          await sb.from('genre_preferences').insert({ profile_id: profile.id, genre: genreKey, score: 5 });
        }
      } catch {}
    }

    // Success message
    let successText = `✅ *Трек загружен!*\n\n`;
    successText += `🎵 *${title}*\n`;
    if (artist) successText += `👤 ${artist}\n`;
    if (album) successText += `💿 ${album}\n`;
    if (genre) successText += `🏷️ ${genre}\n`;
    if (duration) successText += `⏱️ ${formatDuration(duration)}\n`;
    successText += `\n[Открыть на сайте](${SITE_URL}/app.html)`;

    await bot.editMessageText(successText, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });

  } catch (err) {
    console.error('Audio handler error:', err);
    await bot.editMessageText('❌ Произошла ошибка: ' + err.message, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
    }).catch(() => {});
  }
}

// ─── UNKNOWN ────────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.audio || msg.document) return;
  if (msg.text && msg.text.startsWith('/')) return;

  if (msg.text) {
    await bot.sendMessage(msg.chat.id,
      `Отправь MP3 файл чтобы загрузить трек 🎵\n\nИли используй:\n/connect — войти на сайт\n/mytracks — мои треки\n/help — помощь`
    );
  }
});

// ─── ERROR HANDLING ─────────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));