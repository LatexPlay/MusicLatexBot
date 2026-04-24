const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');
const mm = require('music-metadata');
const crypto = require('crypto');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN   || '8735781048:AAFVC3jH5tkjTxYXsswZ42Op858mjXrWKfU';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rdwrkvsdcudzttnywuai.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_YsoKq4O182TiMVR-AGj8lQ_7XflhXBh';
const SITE_URL    = process.env.SITE_URL    || 'https://latexplay.github.io/LatexPlay/app.html';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const sb  = createClient(SUPABASE_URL, SUPABASE_KEY);

// Поддерживаемые аудио форматы
const AUDIO_MIME_TYPES = new Set([
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/m4a', 'audio/x-m4a',
  'audio/flac', 'audio/x-flac',
  'audio/ogg', 'audio/vorbis',
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/aac', 'audio/x-aac',
  'audio/opus',
  'audio/webm',
  'audio/3gpp', 'audio/3gpp2',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'flac', 'ogg', 'wav', 'aac', 'opus', 'wma', 'alac', 'aiff', 'aif', 'webm', '3gp',
]);

function isAudioFile(mimeType, fileName) {
  if (mimeType && AUDIO_MIME_TYPES.has(mimeType.toLowerCase())) return true;
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (ext && AUDIO_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function getAudioMime(fileName, originalMime) {
  const ext = fileName?.split('.').pop()?.toLowerCase();
  const map = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
    ogg: 'audio/ogg', wav: 'audio/wav', aac: 'audio/aac',
    opus: 'audio/opus', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
    aif: 'audio/aiff', webm: 'audio/webm',
  };
  return (ext && map[ext]) || originalMime || 'audio/mpeg';
}

// ─── HELPERS ────────────────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function formatDuration(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

async function getTelegramPhotoUrl(userId) {
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos || photos.total_count === 0) return null;
    const fileId = photos.photos[0]?.[0]?.file_id;
    if (!fileId) return null;
    const file = await bot.getFile(fileId);
    return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  } catch {
    return null;
  }
}

async function getOrCreateProfile(telegramUser) {
  try {
    const avatarUrl = await getTelegramPhotoUrl(telegramUser.id);
    const displayName = [telegramUser.first_name, telegramUser.last_name].filter(Boolean).join(' ');

    const { data: existing } = await sb
      .from('profiles').select('*').eq('telegram_id', telegramUser.id).single();

    if (existing) {
      if (avatarUrl && avatarUrl !== existing.avatar_url) {
        await sb.from('profiles').update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() }).eq('id', existing.id);
        existing.avatar_url = avatarUrl;
      }
      return existing;
    }

    const { data: newProfile, error } = await sb.from('profiles').insert({
      telegram_id: telegramUser.id,
      username:    telegramUser.username || null,
      display_name: displayName,
      avatar_url:  avatarUrl,
    }).select().single();

    if (error) { console.error('Profile create error:', error); return null; }
    return newProfile;
  } catch (err) {
    console.error('getOrCreateProfile error:', err);
    return null;
  }
}

// ─── /start ─────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  await getOrCreateProfile(msg.from);

  await bot.sendMessage(chatId,
    `🎵 *Добро пожаловать в LatexPlay!*\n\n` +
    `Загружай музыку прямо из Telegram — она появится на платформе.\n\n` +
    `*Поддерживаемые форматы:*\nMP3, M4A, FLAC, OGG, WAV, AAC, OPUS и другие\n\n` +
    `*Команды:*\n` +
    `• 🔗 /connect — получить код для входа на сайт\n` +
    `• 🎵 Отправь аудио файл — он появится на платформе\n` +
    `• 📋 /mytracks — список твоих треков\n` +
    `• ❌ /delete — удалить трек\n` +
    `• ℹ️ /help — помощь\n\n` +
    `Начни с /connect чтобы привязать аккаунт к сайту!`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

// ─── /connect ───────────────────────────────────────────────────────────────
bot.onText(/\/connect/, async (msg) => {
  const chatId = msg.chat.id;
  const user   = msg.from;

  try {
    const avatarUrl   = await getTelegramPhotoUrl(user.id);
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const code        = generateCode();

    await sb.from('auth_codes').delete().eq('telegram_id', user.id).eq('used', false);
    await sb.from('auth_codes').insert({
      code,
      telegram_id:      user.id,
      telegram_username: user.username || null,
      display_name:     displayName,
      avatar_url:       avatarUrl,
      expires_at:       new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    await bot.sendMessage(chatId,
      `🔑 *Твой код для входа:*\n\n\`${code}\`\n\n` +
      `Введи его на [сайте](${SITE_URL}) в поле авторизации.\n\n` +
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
  await bot.sendMessage(msg.chat.id,
    `ℹ️ *Справка LatexPlay Bot*\n\n` +
    `*/start* — приветствие\n` +
    `*/connect* — получить код для входа на сайт\n` +
    `*/mytracks* — посмотреть свои загруженные треки\n` +
    `*/delete [номер]* — удалить трек\n\n` +
    `*Загрузка музыки:*\n` +
    `Просто отправь боту аудио файл любого формата:\n` +
    `MP3 · M4A · FLAC · OGG · WAV · AAC · OPUS · WMA и другие\n\n` +
    `Бот автоматически прочитает теги (название, исполнитель, жанр, обложка) и загрузит трек.\n\n` +
    `*Сайт:* ${SITE_URL}`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );
});

// ─── /mytracks ──────────────────────────────────────────────────────────────
bot.onText(/\/mytracks/, async (msg) => {
  const chatId = msg.chat.id;
  const { data: profile } = await sb.from('profiles').select('id').eq('telegram_id', msg.from.id).single();

  if (!profile) return bot.sendMessage(chatId, '❌ Аккаунт не найден. Используй /connect для привязки.');

  const { data: tracks } = await sb.from('tracks')
    .select('id, title, artist, genre, duration, play_count, created_at')
    .eq('uploaded_by', profile.id)
    .order('created_at', { ascending: false });

  if (!tracks?.length) return bot.sendMessage(chatId, '🎵 У тебя пока нет загруженных треков.\n\nОтправь мне аудио файл!');

  let text = `🎵 *Твои треки (${tracks.length}):*\n\n`;
  tracks.forEach((t, i) => {
    text += `${i + 1}. *${t.title}*`;
    if (t.artist) text += ` — ${t.artist}`;
    if (t.genre) text += ` \`[${t.genre}]\``;
    text += `\n   ▶️ ${t.play_count || 0} прослушиваний · ${formatDuration(t.duration)}\n\n`;
  });
  text += `\nДля удаления: /delete \`номер\``;

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
});

// ─── /delete ────────────────────────────────────────────────────────────────
bot.onText(/\/delete(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const num    = match[1] ? parseInt(match[1]) : null;

  if (!num) return bot.sendMessage(chatId, 'Укажи номер трека: /delete `1`\n\nПосмотреть список: /mytracks', { parse_mode: 'Markdown' });

  const { data: profile } = await sb.from('profiles').select('id').eq('telegram_id', msg.from.id).single();
  if (!profile) return bot.sendMessage(chatId, '❌ Аккаунт не найден.');

  const { data: tracks } = await sb.from('tracks').select('id, title, file_url')
    .eq('uploaded_by', profile.id).order('created_at', { ascending: false });

  if (!tracks?.length) return bot.sendMessage(chatId, '🎵 Нет треков для удаления.');
  const track = tracks[num - 1];
  if (!track) return bot.sendMessage(chatId, `❌ Трека с номером ${num} нет. У тебя ${tracks.length} треков.`);

  // Удаляем файл из storage
  try {
    // Пробуем удалить по пути из URL
    const url = new URL(track.file_url);
    const pathParts = url.pathname.split('/tracks/');
    if (pathParts[1]) await sb.storage.from('tracks').remove([pathParts[1]]);
  } catch {}

  await sb.from('tracks').delete().eq('id', track.id);
  await bot.sendMessage(chatId, `✅ Трек *${track.title}* удалён.`, { parse_mode: 'Markdown' });
});

// ─── AUDIO HANDLERS ─────────────────────────────────────────────────────────
// Telegram присылает аудио как `audio` (когда Telegram распознаёт как музыку)
// или как `document` (когда отправлено как файл)
bot.on('audio', (msg) => handleAudio(msg, false));

bot.on('document', async (msg) => {
  const doc = msg.document;
  if (!doc) return;
  if (isAudioFile(doc.mime_type, doc.file_name)) {
    await handleAudio(msg, true);
  } else {
    await bot.sendMessage(msg.chat.id, '❌ Этот формат не поддерживается.\n\nОтправь аудио файл: MP3, M4A, FLAC, OGG, WAV, AAC, OPUS и другие.');
  }
});

// voice — это голосовые, не музыка, но на всякий случай обработаем
bot.on('voice', async (msg) => {
  await bot.sendMessage(msg.chat.id, '❌ Голосовые сообщения не принимаются.\n\nОтправь аудио файл: MP3, M4A, FLAC, OGG, WAV и другие.');
});

async function handleAudio(msg, isDocument = false) {
  const chatId = msg.chat.id;
  const user   = msg.from;

  // Безопасно получаем объект файла
  const fileObj = isDocument ? msg.document : msg.audio;
  if (!fileObj || !fileObj.file_id) {
    return bot.sendMessage(chatId, '❌ Не удалось получить файл. Попробуй отправить ещё раз.');
  }

  const profile = await getOrCreateProfile(user);
  if (!profile) return bot.sendMessage(chatId, '❌ Ошибка профиля. Попробуй /start');

  const statusMsg = await bot.sendMessage(chatId, '⏳ Загружаю трек...');

  const edit = (text) => bot.editMessageText(text, {
    chat_id: chatId, message_id: statusMsg.message_id
  }).catch(() => {});

  try {
    const fileId   = fileObj.file_id;
    const fileSize = fileObj.file_size || 0;
    const fileName = fileObj.file_name || (isDocument ? 'track' : `${msg.audio?.title || 'track'}.mp3`);
    const mimeType = fileObj.mime_type || getAudioMime(fileName, 'audio/mpeg');

    if (fileSize > 50 * 1024 * 1024) {
      return edit('❌ Файл слишком большой. Максимум 50MB.');
    }

    // Скачиваем файл
    await edit('⏳ Скачиваю файл...');
    const fileLink = await bot.getFileLink(fileId);
    const fileResp = await fetch(fileLink);
    if (!fileResp.ok) throw new Error('Не удалось скачать файл');
    const fileBuffer = Buffer.from(await fileResp.arrayBuffer());

    // Читаем метаданные
    await edit('🔍 Читаю теги...');

    let title    = null;
    let artist   = null;
    let album    = null;
    let genre    = null;
    let duration = null;
    let coverBuffer = null;
    let coverMime   = null;

    try {
      const metadata = await mm.parseBuffer(fileBuffer, mimeType);
      const tags = metadata.common;
      const info = metadata.format;

      title    = tags.title   || null;
      artist   = tags.artist  || null;
      album    = tags.album   || null;
      genre    = tags.genre?.[0] || null;
      duration = info.duration ? Math.round(info.duration) : null;

      if (tags.picture?.length > 0) {
        coverBuffer = Buffer.from(tags.picture[0].data);
        coverMime   = tags.picture[0].format || 'image/jpeg';
      }
    } catch (metaErr) {
      console.warn('Metadata parse failed:', metaErr.message);
    }

    // Фолбэк на Telegram поля
    if (!title) {
      title = msg.audio?.title
        || fileName.replace(/\.[^.]+$/, '')
        || 'Unknown Track';
    }
    if (!artist && msg.audio?.performer) artist = msg.audio.performer;
    if (!duration && msg.audio?.duration)  duration = msg.audio.duration;

    // Загружаем аудио в Supabase Storage
    await edit('📤 Загружаю на сервер...');

    const trackId  = crypto.randomUUID();
    const fileExt  = fileName.split('.').pop()?.toLowerCase() || 'mp3';
    const audioPath = `${trackId}.${fileExt}`;
    const uploadMime = getAudioMime(fileName, mimeType);

    const { error: uploadErr } = await sb.storage
      .from('tracks')
      .upload(audioPath, fileBuffer, { contentType: uploadMime, upsert: false });

    if (uploadErr) {
      console.error('Upload error:', uploadErr);
      return edit('❌ Ошибка загрузки файла: ' + uploadErr.message);
    }

    const { data: pubData } = sb.storage.from('tracks').getPublicUrl(audioPath);
    const fileUrl = pubData.publicUrl;

    // Загружаем обложку
    let coverUrl = null;
    if (coverBuffer) {
      try {
        const coverExt  = coverMime?.includes('png') ? 'png' : 'jpg';
        const coverPath = `covers/${trackId}.${coverExt}`;
        const { error: covErr } = await sb.storage.from('tracks').upload(coverPath, coverBuffer, { contentType: coverMime, upsert: false });
        if (!covErr) {
          const { data: covPub } = sb.storage.from('tracks').getPublicUrl(coverPath);
          coverUrl = covPub.publicUrl;
        }
      } catch (e) {
        console.warn('Cover upload failed:', e.message);
      }
    }

    // Сохраняем в БД
    const { data: newTrack, error: dbErr } = await sb.from('tracks').insert({
      id: trackId, title, artist, album, genre,
      duration, file_url: fileUrl, cover_url: coverUrl,
      uploaded_by: profile.id, play_count: 0,
    }).select().single();

    if (dbErr) {
      console.error('DB error:', dbErr);
      return edit('❌ Ошибка сохранения: ' + dbErr.message);
    }

    // Обновляем жанровые предпочтения
    if (genre && profile.id) {
      try {
        const genreKey = genre.toLowerCase();
        const { data: gp } = await sb.from('genre_preferences')
          .select('*').eq('profile_id', profile.id).eq('genre', genreKey).single();
        if (gp) {
          await sb.from('genre_preferences').update({ score: gp.score + 5, updated_at: new Date().toISOString() }).eq('id', gp.id);
        } else {
          await sb.from('genre_preferences').insert({ profile_id: profile.id, genre: genreKey, score: 5 });
        }
      } catch {}
    }

    // Сообщение об успехе
    const ext = fileExt.toUpperCase();
    let successText = `✅ *Трек загружен!*\n\n`;
    successText += `🎵 *${title}*\n`;
    if (artist)   successText += `👤 ${artist}\n`;
    if (album)    successText += `💿 ${album}\n`;
    if (genre)    successText += `🏷️ ${genre}\n`;
    if (duration) successText += `⏱️ ${formatDuration(duration)}\n`;
    successText += `📁 Формат: ${ext}\n`;
    successText += `\n[Открыть на сайте](${SITE_URL})`;

    await edit(successText);
    // Пробуем добавить parse_mode через sendMessage если editMessageText не поддержит
    await bot.editMessageText(successText, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    }).catch(() => {});

  } catch (err) {
    console.error('Audio handler error:', err);
    await edit('❌ Произошла ошибка: ' + err.message);
  }
}

// ─── UNKNOWN MESSAGES ────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (msg.audio || msg.document || msg.voice) return;
  if (msg.text?.startsWith('/')) return;
  if (msg.text) {
    await bot.sendMessage(msg.chat.id,
      `Отправь аудио файл чтобы загрузить трек 🎵\n\nПоддерживается: MP3, M4A, FLAC, OGG, WAV, AAC, OPUS\n\nИли используй:\n/connect — войти на сайт\n/mytracks — мои треки\n/help — помощь`
    );
  }
});

// ─── ERROR HANDLING ──────────────────────────────────────────────────────────
bot.on('polling_error', (err) => console.error('Polling error:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

console.log('🎵 LatexPlay Bot started — supporting MP3, M4A, FLAC, OGG, WAV, AAC, OPUS and more');
