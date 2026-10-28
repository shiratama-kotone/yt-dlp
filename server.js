'use strict';

/**
 * 個人用 YouTube ダウンロードサーバー
 * - Node.js + Express
 * - yt-dlp で画質一覧取得・ダウンロード
 * - 映像/音声が分かれている場合は ffmpeg で自動結合
 * - パスワード認証付き（環境変数 API_PASSWORD）
 * - ダウンロードはジョブ方式
 * - 保存ファイル名をユーザーが指定可能
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const API_PASSWORD = process.env.API_PASSWORD || '';
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000);

if (!API_PASSWORD) {
  console.warn(
    '[WARN] API_PASSWORD が設定されていません。誰でもAPIを叩ける状態です。' +
    ' Render の環境変数で API_PASSWORD を必ず設定してください。'
  );
}

// ---------------------------------------------------------------------------
// YouTube cookies
// ---------------------------------------------------------------------------
const COOKIES_PATH = path.join(os.tmpdir(), 'ytdlp-cookies.txt');

function loadCookiesFromEnv() {
  if (process.env.YTDLP_COOKIES_B64) {
    try {
      const decoded = Buffer
        .from(process.env.YTDLP_COOKIES_B64, 'base64')
        .toString('utf8');

      fs.writeFileSync(COOKIES_PATH, decoded, 'utf8');
      console.log('[INFO] YTDLP_COOKIES_B64 から cookies.txt を読み込みました');
    } catch (err) {
      console.error('[WARN] cookie の読み込みに失敗しました', err);
    }
  }
}

loadCookiesFromEnv();

function cookieArgs() {
  return fs.existsSync(COOKIES_PATH)
    ? ['--cookies', COOKIES_PATH]
    : [];
}

// ---------------------------------------------------------------------------
// yt-dlp の対策用引数
// ---------------------------------------------------------------------------
function resilienceArgs() {
  return [
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:github',
    '--extractor-args', 'youtube:formats=missing_pot',
  ];
}

// ---------------------------------------------------------------------------
// 保存ファイル名のサニタイズ
// 拡張子はサーバー側で自動的に付ける
// ---------------------------------------------------------------------------
function sanitizeFileName(value) {
  let name = String(value || '').normalize('NFC').trim();

  // 空欄の場合は自動命名にする
  if (!name) return '';

  // 動画・音声の一般的な拡張子だけを取り除く
  name = name.replace(/\.(mp4|mp3|m4a|webm|mkv|mov|wav|aac|opus)$/i, '');

  // パス区切りやファイル名に使えない文字を置換
  name = name.replace(/[\/\\:*?"<>|\x00-\x1F]/g, '_');

  // 末尾のドットや空白を取り除く
  name = name.replace(/[. ]+$/g, '').trim();

  // 「.」や空白だけだった場合も自動命名にする
  if (!name || name === '.' || name === '..') return '';

  // yt-dlp の出力テンプレートとして解釈される % を置換
  name = name.replace(/%/g, '_');

  // UTF-8で160バイト以内に制限する
  const chars = Array.from(name);

  while (
    chars.length > 0 &&
    Buffer.byteLength(chars.join(''), 'utf8') > 160
  ) {
    chars.pop();
  }

  return chars.join('').trim();
}

// ---------------------------------------------------------------------------
// 認証ミドルウェア
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!API_PASSWORD) return next();

  const supplied =
    req.header('x-api-password') ||
    req.query.password ||
    (req.body && req.body.password) ||
    '';

  if (supplied !== API_PASSWORD) {
    return res.status(401).json({
      error: 'パスワードが違います（unauthorized）',
    });
  }

  next();
}

// ---------------------------------------------------------------------------
// ジョブ管理
// ---------------------------------------------------------------------------
const jobs = new Map();

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  if (job.tempDir) {
    fs.rm(job.tempDir, { recursive: true, force: true }, () => {});
  }

  jobs.delete(jobId);
}

// 古いジョブを定期的に掃除する
setInterval(() => {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      cleanupJob(jobId);
    }
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// コマンド実行ヘルパー
// ---------------------------------------------------------------------------
function runCommand(cmd, args, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`コマンドがタイムアウトしました: ${cmd}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const tailOut = stdout
          ? `\n--- stdout(tail) ---\n${stdout.slice(-1500)}`
          : '';

        reject(new Error((stderr || `終了コード ${code}`) + tailOut));
      }
    });
  });
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /api/debug?url=...
// ---------------------------------------------------------------------------
app.get('/api/debug', requireAuth, async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({
      error: 'url パラメータが不正です',
    });
  }

  try {
    const result = await runCommand('yt-dlp', [
      ...cookieArgs(),
      ...resilienceArgs(),
      '-v',
      '--list-formats',
      '--no-playlist',
      url,
    ], {
      timeoutMs: 90 * 1000,
    });

    res.json({
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (err) {
    res.json({
      ok: false,
      error: String(err.message || err),
    });
  }
});

// ---------------------------------------------------------------------------
// GET /api/formats?url=...
// ---------------------------------------------------------------------------
app.get('/api/formats', requireAuth, async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({
      error: 'url パラメータが不正です',
    });
  }

  try {
    const { stdout } = await runCommand('yt-dlp', [
      ...cookieArgs(),
      ...resilienceArgs(),
      '-j',
      '--no-warnings',
      '--no-playlist',
      url,
    ], {
      timeoutMs: 60 * 1000,
    });

    const info = JSON.parse(stdout);

    const formats = (info.formats || [])
      .filter((f) => {
        if (f.format_note === 'storyboard') return false;
        if (f.vcodec === 'none' && f.acodec === 'none') return false;
        if (!f.url && !f.manifest_url) return false;
        return true;
      })
      .map((f) => {
        const hasVideo = f.vcodec && f.vcodec !== 'none';
        const hasAudio = f.acodec && f.acodec !== 'none';
        const sizeBytes = f.filesize || f.filesize_approx || null;

        return {
          formatId: f.format_id,
          ext: f.ext,
          resolution: hasVideo
            ? (
                f.height
                  ? `${f.height}p${f.fps && f.fps > 30 ? f.fps : ''}`
                  : (f.format_note || '不明')
              )
            : '音声のみ',
          height: hasVideo ? (f.height || null) : null,
          hasVideo: !!hasVideo,
          hasAudio: !!hasAudio,
          needsMerge: !!hasVideo && !hasAudio,
          fps: f.fps || null,
          vcodec: f.vcodec,
          acodec: f.acodec,
          abr: f.abr || null,
          tbr: f.tbr || null,
          filesizeMB: sizeBytes
            ? Math.round((sizeBytes / 1024 / 1024) * 10) / 10
            : null,
          note: f.format_note || '',
        };
      })
      .sort((a, b) => {
        if (a.hasVideo !== b.hasVideo) {
          return a.hasVideo ? -1 : 1;
        }

        const ah = parseInt(a.resolution) || 0;
        const bh = parseInt(b.resolution) || 0;

        if (ah !== bh) return bh - ah;

        return (b.tbr || 0) - (a.tbr || 0);
      });

    res.json({
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      uploader: info.uploader,
      formats,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: '画質一覧の取得に失敗しました',
      detail: String(err.message || err),
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cookies
// ---------------------------------------------------------------------------
app.post(
  '/api/cookies',
  requireAuth,
  express.text({ limit: '2mb', type: '*/*' }),
  (req, res) => {
    try {
      if (
        !req.body ||
        typeof req.body !== 'string' ||
        !req.body.trim()
      ) {
        return res.status(400).json({
          error: 'cookies.txt の中身が空です',
        });
      }

      fs.writeFileSync(COOKIES_PATH, req.body, 'utf8');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({
        error: String(err.message || err),
      });
    }
  }
);

// ---------------------------------------------------------------------------
// POST /api/download
// body: { url, height, audioOnly, fileName, password }
// ---------------------------------------------------------------------------
app.post('/api/download', requireAuth, (req, res) => {
  const {
    url,
    height,
    audioOnly,
    fileName,
  } = req.body || {};

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({
      error: 'url が不正です',
    });
  }

  if (
    !audioOnly &&
    height !== undefined &&
    height !== null &&
    (!Number.isFinite(Number(height)) || Number(height) <= 0)
  ) {
    return res.status(400).json({
      error: 'height が不正です',
    });
  }

  const safeFileName = sanitizeFileName(fileName);

  const jobId = crypto.randomUUID();

  jobs.set(jobId, {
    status: 'pending',
    createdAt: Date.now(),
  });

  processDownloadJob(
    jobId,
    url,
    height ? Number(height) : null,
    !!audioOnly,
    safeFileName
  ).catch((err) => {
    console.error(`[job ${jobId}] unexpected error`, err);
  });

  res.json({ jobId });
});

// ---------------------------------------------------------------------------
// ダウンロードジョブ本体
// ---------------------------------------------------------------------------
async function processDownloadJob(
  jobId,
  url,
  height,
  audioOnly,
  requestedFileName
) {
  const job = jobs.get(jobId);
  if (!job) return;

  job.status = 'processing';

  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ytdl-')
  );

  job.tempDir = tempDir;

  try {
    // ファイル名が指定されていれば使用し、空欄なら動画タイトルを使う
    const outputTemplate = requestedFileName
      ? path.join(
          tempDir,
          `${requestedFileName}.%(ext)s`
        )
      : path.join(
          tempDir,
          '%(title).100s [%(id)s].%(ext)s'
        );

    let args;
    let expectedExt;

    if (audioOnly) {
      // 音声のみ: MP3に変換
      args = [
        ...cookieArgs(),
        ...resilienceArgs(),
        '-f', 'bestaudio/best',
        '--extract-audio',
        '--audio-format', 'mp3',
        '--audio-quality', '0',
        '--no-playlist',
        '--no-warnings',
        '-o', outputTemplate,
        url,
      ];

      expectedExt = '.mp3';
    } else {
      // 指定した高さ以下で最適な映像・音声を取得
      const h = height ? `[height<=${height}]` : '';
      const formatArg = `bestvideo${h}+bestaudio/best${h}/best`;

      args = [
        ...cookieArgs(),
        ...resilienceArgs(),
        '-f', formatArg,
        '--merge-output-format', 'mp4',
        '--remux-video', 'mp4',
        '--no-playlist',
        '--no-warnings',
        '-o', outputTemplate,
        url,
      ];

      expectedExt = '.mp4';
    }

    await runCommand('yt-dlp', args, {
      timeoutMs: 20 * 60 * 1000,
    });

    const files = fs.readdirSync(tempDir).filter((f) =>
      f.toLowerCase().endsWith(expectedExt)
    );

    if (files.length === 0) {
      throw new Error(
        '出力ファイルが見つかりませんでした（未対応フォーマットの可能性があります）'
      );
    }

    const finalPath = path.join(tempDir, files[0]);

    job.filePath = finalPath;
    job.fileName = files[0];
    job.status = 'done';
  } catch (err) {
    console.error(`[job ${jobId}] failed`, err);

    job.status = 'error';
    job.error = String(err.message || err);

    fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
}

// ---------------------------------------------------------------------------
// GET /api/download/:jobId/status
// ---------------------------------------------------------------------------
app.get('/api/download/:jobId/status', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({
      error: 'ジョブが見つかりません（期限切れの可能性）',
    });
  }

  res.json({
    status: job.status,
    error: job.error || null,
    fileName: job.fileName || null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/download/:jobId/file
// ---------------------------------------------------------------------------
app.get('/api/download/:jobId/file', requireAuth, (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      error: 'ジョブが見つかりません（期限切れの可能性）',
    });
  }

  if (job.status !== 'done') {
    return res.status(409).json({
      error: 'まだ準備できていません',
      status: job.status,
    });
  }

  res.download(job.filePath, job.fileName, (err) => {
    if (err) {
      console.error(`[job ${jobId}] send error`, err);
    }

    cleanupJob(jobId);
  });
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`yt-dlp personal server listening on port ${PORT}`);
});