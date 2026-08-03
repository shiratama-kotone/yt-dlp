'use strict';

/**
 * 個人用 YouTube ダウンロードサーバー
 * - Node.js + Express
 * - yt-dlp で画質一覧取得・ダウンロード
 * - 映像/音声が分かれている場合は yt-dlp が内部で ffmpeg を呼び出して自動結合し、MP4として返す
 * - パスワード認証付き（環境変数 API_PASSWORD）
 * - ダウンロードはジョブ方式（ポーリング）。Render のリクエストタイムアウトを回避するため。
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
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000); // デフォルト1時間

if (!API_PASSWORD) {
  console.warn(
    '[WARN] API_PASSWORD が設定されていません。誰でもAPIを叩ける状態です。' +
    ' Render の環境変数で API_PASSWORD を必ず設定してください。'
  );
}

// ---------------------------------------------------------------------------
// YouTube の "bot確認" 対策用 cookie（Netscape形式 cookies.txt）
// - 起動時: 環境変数 YTDLP_COOKIES_B64（cookies.txtをbase64にしたもの）があれば読み込む
// - 実行中: POST /api/cookies に生のcookies.txtを送ると再デプロイなしで更新できる
// ---------------------------------------------------------------------------
const COOKIES_PATH = path.join(os.tmpdir(), 'ytdlp-cookies.txt');

function loadCookiesFromEnv() {
  if (process.env.YTDLP_COOKIES_B64) {
    try {
      const decoded = Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf8');
      fs.writeFileSync(COOKIES_PATH, decoded, 'utf8');
      console.log('[INFO] YTDLP_COOKIES_B64 から cookies.txt を読み込みました');
    } catch (err) {
      console.error('[WARN] cookie の読み込みに失敗しました', err);
    }
  }
}
loadCookiesFromEnv();

function cookieArgs() {
  return fs.existsSync(COOKIES_PATH) ? ['--cookies', COOKIES_PATH] : [];
}

// ---------------------------------------------------------------------------
// YouTubeのSABR配信強制・署名/nチャレンジ対策
// - ベースイメージに元々入っているNode.jsをJSランタイムとしてyt-dlpに使わせる
// - yt-dlp-ejs（Dockerfileでインストール済み）が古い場合に備え、GitHubから
//   最新の解決コンポーネントを取得することも許可しておく
// - 複数のplayer_clientを試させることで、特定クライアントのみSABR強制されて
//   フォーマットが取れないケースを回避する
// ---------------------------------------------------------------------------
function resilienceArgs() {
  return [
    '--js-runtimes', 'deno',
    '--remote-components', 'ejs:github',
    // PO Token(Proof of Origin)が無いとYouTubeが実フォーマットを隠し「画像のみ」しか
    // 返さなくなることがあり、これが "Requested format is not available" の主因になり得る。
    // PO Tokenが無くても取得できるフォーマットは強制的に含めさせる。
    '--extractor-args', 'youtube:formats=missing_pot',
  ];
}

// ---------------------------------------------------------------------------
// 認証ミドルウェア
// ヘッダー "x-api-password" か クエリ/ボディの "password" のどちらかでチェックする
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  if (!API_PASSWORD) return next(); // パスワード未設定なら素通し（非推奨）

  const supplied =
    req.header('x-api-password') ||
    req.query.password ||
    (req.body && req.body.password) ||
    '';

  if (supplied !== API_PASSWORD) {
    return res.status(401).json({ error: 'パスワードが違います（unauthorized）' });
  }
  next();
}

// ---------------------------------------------------------------------------
// ジョブ管理（メモリ上のみ。個人用途・単一インスタンス前提）
// ---------------------------------------------------------------------------
/**
 * jobs: Map<jobId, {
 *   status: 'pending' | 'processing' | 'done' | 'error',
 *   error?: string,
 *   tempDir?: string,
 *   filePath?: string,
 *   fileName?: string,
 *   createdAt: number,
 * }>
 */
const jobs = new Map();

function cleanupJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.tempDir) {
    fs.rm(job.tempDir, { recursive: true, force: true }, () => {});
  }
  jobs.delete(jobId);
}

// 古いジョブ（一時ファイル）を定期的に掃除する
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
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`コマンドがタイムアウトしました: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        // 原因調査しやすいよう stderr に加えて stdout の末尾も含める
        const tailOut = stdout ? `\n--- stdout(tail) ---\n${stdout.slice(-1500)}` : '';
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
// GET /api/health : 死活監視用
// ---------------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GET /api/debug?url=...
// yt-dlp の --list-formats を詳細ログ付きで実行し、生の出力をそのまま返す。
// 「Requested format is not available」等の原因調査用（実ダウンロードはしない）。
// ---------------------------------------------------------------------------
app.get('/api/debug', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'url パラメータが不正です' });
  }

  try {
    const result = await runCommand('yt-dlp', [
      ...cookieArgs(),
      ...resilienceArgs(),
      '-v',
      '--list-formats',
      '--no-playlist',
      url,
    ], { timeoutMs: 90 * 1000 });
    res.json({ ok: true, stdout: result.stdout, stderr: result.stderr });
  } catch (err) {
    // runCommand は失敗時 stderr(にstdoutを含まない) を message にして reject するため、
    // ここでは失敗時の出力もそのまま返す（原因調査が目的なので500にはしない）
    res.json({ ok: false, error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/formats?url=...&password=...
// 指定した動画の利用可能な画質一覧を取得する
// ---------------------------------------------------------------------------
app.get('/api/formats', requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'url パラメータが不正です' });
  }

  try {
    const { stdout } = await runCommand('yt-dlp', [
      ...cookieArgs(),
      ...resilienceArgs(),
      '-j',
      '--no-warnings',
      '--no-playlist',
      url,
    ], { timeoutMs: 60 * 1000 });

    const info = JSON.parse(stdout);

    const formats = (info.formats || [])
      .filter((f) => {
        // storyboard や再生不能フォーマットを除外
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
          resolution: hasVideo ? (f.height ? `${f.height}p${f.fps && f.fps > 30 ? f.fps : ''}` : (f.format_note || '不明')) : '音声のみ',
          height: hasVideo ? (f.height || null) : null,
          hasVideo: !!hasVideo,
          hasAudio: !!hasAudio,
          needsMerge: !!hasVideo && !hasAudio,
          fps: f.fps || null,
          vcodec: f.vcodec,
          acodec: f.acodec,
          abr: f.abr || null,
          tbr: f.tbr || null,
          filesizeMB: sizeBytes ? Math.round((sizeBytes / 1024 / 1024) * 10) / 10 : null,
          note: f.format_note || '',
        };
      })
      // 動画（高画質順）→ 音声のみ の順に並べる
      .sort((a, b) => {
        if (a.hasVideo !== b.hasVideo) return a.hasVideo ? -1 : 1;
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
    res.status(500).json({ error: '画質一覧の取得に失敗しました', detail: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/cookies  body: cookies.txt の中身をそのまま（Content-Type: text/plain）
// YouTubeの "bot確認" が出た時、ブラウザからエクスポートしたcookieを
// 再デプロイなしで反映するためのエンドポイント（サーバー再起動で消える）
// ---------------------------------------------------------------------------
app.post('/api/cookies', requireAuth, express.text({ limit: '2mb', type: '*/*' }), (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'string' || !req.body.trim()) {
      return res.status(400).json({ error: 'cookies.txt の中身が空です' });
    }
    fs.writeFileSync(COOKIES_PATH, req.body, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// ---------------------------------------------------------------------------
// POST /api/download  body: { url, height, password }
// ダウンロードジョブを作成し、即座に jobId を返す（非同期処理）
//
// 注: 特定の format_id (itag) を直接指定すると、一覧取得時と実際のダウンロード時で
// YouTube側が返すitagにズレが生じ "Requested format is not available" になることが
// あるため、「指定した高さ(height)以下でベストなものを自動選択」という
// セレクタ方式にして堅牢性を高めている。
// ---------------------------------------------------------------------------
app.post('/api/download', requireAuth, (req, res) => {
  const { url, height } = req.body || {};
  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: 'url が不正です' });
  }
  if (height !== undefined && height !== null && (!Number.isFinite(Number(height)) || Number(height) <= 0)) {
    return res.status(400).json({ error: 'height が不正です' });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'pending', createdAt: Date.now() });

  // 非同期でバックグラウンド処理を開始（レスポンスは待たせない）
  processDownloadJob(jobId, url, height ? Number(height) : null).catch((err) => {
    console.error(`[job ${jobId}] unexpected error`, err);
  });

  res.json({ jobId });
});

async function processDownloadJob(jobId, url, height) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'processing';

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdl-'));
  job.tempDir = tempDir;

  try {
    // 高さ制約付きのベスト映像+ベスト音声を狙い、ダメなら段階的にフォールバックする
    const h = height ? `[height<=${height}]` : '';
    const formatArg = `bestvideo${h}+bestaudio/best${h}/best`;

    // タイトルはyt-dlpの出力テンプレートに任せ、実際に生成されたファイル名をそのまま使う
    const outputTemplate = path.join(tempDir, '%(title).100s [%(id)s].%(ext)s');

    await runCommand('yt-dlp', [
      ...cookieArgs(),
      ...resilienceArgs(),
      '-f', formatArg,
      '--merge-output-format', 'mp4',   // 映像+音声が分かれている場合、ffmpegで結合してmp4化
      '--remux-video', 'mp4',           // 既に結合済みでもコンテナをmp4に統一（再エンコードなし）
      '--no-playlist',
      '--no-warnings',
      '-o', outputTemplate,
      url,
    ], { timeoutMs: 20 * 60 * 1000 });

    const files = fs.readdirSync(tempDir).filter((f) => f.toLowerCase().endsWith('.mp4'));
    if (files.length === 0) {
      throw new Error('出力ファイルが見つかりませんでした（未対応フォーマットの可能性があります）');
    }

    const finalPath = path.join(tempDir, files[0]);

    job.filePath = finalPath;
    job.fileName = files[0];
    job.status = 'done';
  } catch (err) {
    console.error(`[job ${jobId}] failed`, err);
    job.status = 'error';
    job.error = String(err.message || err);
    // 失敗時は一時ファイルを掃除（ジョブ情報自体はエラー確認のため少し残す）
    fs.rm(tempDir, { recursive: true, force: true }, () => {});
  }
}

// ---------------------------------------------------------------------------
// GET /api/download/:jobId/status
// ---------------------------------------------------------------------------
app.get('/api/download/:jobId/status', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'ジョブが見つかりません（期限切れの可能性）' });

  res.json({
    status: job.status,
    error: job.error || null,
    fileName: job.fileName || null,
  });
});

// ---------------------------------------------------------------------------
// GET /api/download/:jobId/file
// 完成したMP4ファイルを返す。返却後に一時ファイルを削除する。
// ---------------------------------------------------------------------------
app.get('/api/download/:jobId/file', requireAuth, (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'ジョブが見つかりません（期限切れの可能性）' });
  if (job.status !== 'done') {
    return res.status(409).json({ error: 'まだ準備できていません', status: job.status });
  }

  res.download(job.filePath, job.fileName, (err) => {
    if (err) console.error(`[job ${jobId}] send error`, err);
    // 送信完了後（成功・失敗どちらでも）クリーンアップ
    cleanupJob(jobId);
  });
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`yt-dlp personal server listening on port ${PORT}`);
});