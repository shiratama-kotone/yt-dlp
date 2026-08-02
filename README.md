# YouTube ダウンローダー（個人用 Render サーバー）

Node.js + Express + yt-dlp + ffmpeg で動く、個人用の YouTube ダウンロードサーバーです。
1080p 以上など映像・音声が分かれている画質を選んだ場合も、yt-dlp がサーバー内の ffmpeg を
呼び出して自動的に結合し、完成した MP4 を返します。

**必ず個人利用の範囲で、著作権・利用規約を守ってお使いください。**

---

## 1. 構成ファイル

```
.
├── Dockerfile        # yt-dlp / ffmpeg を含む実行環境
├── render.yaml        # Render Blueprint（任意）
├── package.json
├── server.js           # Express本体
├── public/
│   └── index.html       # 操作用Webページ
└── .gitignore
```

Render は通常の Node 環境だと `apt-get` で ffmpeg / yt-dlp を入れられないため、
**Docker デプロイ**にしています（Dockerfile 内で自動インストール）。

---

## 2. デプロイ手順（Render）

1. このフォルダの中身を GitHub リポジトリにアップロードする
   （Chromebook でも GitHub の Web UI から「Add file → Upload files」でOK）
2. Render のダッシュボードで **New → Web Service** を選択
3. 対象のリポジトリを選ぶ
4. Environment を **Docker** にする（Dockerfile を自動検出します）
5. 環境変数を設定する
   - `API_PASSWORD` : 好きなパスワード（**必須**。設定しないと誰でもアクセスできてしまいます）
   - `JOB_TTL_MS` : 任意。ジョブ（一時ファイル）を保持する時間（ミリ秒）。デフォルト 3600000（1時間）
6. Deploy を押す

`render.yaml` を使う場合は **New → Blueprint** からこのリポジトリを指定してください
（`API_PASSWORD` はダッシュボード側で入力を求められます）。

---

## 3. Web ページの使い方

デプロイ後、`https://<your-app>.onrender.com/` にアクセスすると操作画面が開きます。

1. 「パスワード」欄に `API_PASSWORD` と同じ値を入力
2. YouTube の URL を貼り付け、「画質一覧を取得」
3. 一覧から画質を選択（「要結合」バッジがある画質は映像・音声が別々で、
   サーバー側で自動的に ffmpeg 結合されます）
4. 「選択した画質でダウンロード」を押すと処理が始まり、完了すると自動でダウンロードされます

---

## 4. API 仕様

すべてのAPIは以下のいずれかで認証が必要です（`API_PASSWORD` 未設定時は認証スキップ）。

- ヘッダー: `x-api-password: <パスワード>`
- または クエリ / JSONボディ: `password=<パスワード>`

### 4-1. `GET /api/health`
死活監視用。認証不要。

```bash
curl https://<your-app>.onrender.com/api/health
```

### 4-2. `GET /api/formats?url=<動画URL>`
利用可能な画質一覧を取得する。

```bash
curl -H "x-api-password: YOUR_PASSWORD" \
  "https://<your-app>.onrender.com/api/formats?url=https://www.youtube.com/watch?v=XXXX"
```

レスポンス例：

```json
{
  "title": "動画タイトル",
  "thumbnail": "https://...",
  "duration": 245,
  "uploader": "チャンネル名",
  "formats": [
    {
      "formatId": "137",
      "ext": "mp4",
      "resolution": "1080p",
      "hasVideo": true,
      "hasAudio": false,
      "needsMerge": true,
      "filesizeMB": 84.2,
      "note": ""
    }
  ]
}
```

### 4-3. `POST /api/download`
ダウンロードジョブを作成する（非同期）。すぐに `jobId` が返る。

```bash
curl -X POST -H "Content-Type: application/json" -H "x-api-password: YOUR_PASSWORD" \
  -d '{"url":"https://www.youtube.com/watch?v=XXXX","formatId":"137"}' \
  https://<your-app>.onrender.com/api/download
```

```json
{ "jobId": "5f2c..." }
```

### 4-4. `GET /api/download/:jobId/status`
ジョブの進捗を確認する（2秒間隔程度でポーリングする想定）。

```bash
curl -H "x-api-password: YOUR_PASSWORD" \
  https://<your-app>.onrender.com/api/download/5f2c.../status
```

```json
{ "status": "processing", "error": null, "fileName": null }
```

`status` は `pending` → `processing` → `done`（または `error`）と遷移する。

### 4-5. `GET /api/download/:jobId/file`
完成した MP4 をダウンロードする。**ダウンロード後、サーバー上の一時ファイルは自動削除される**。

```bash
curl -H "x-api-password: YOUR_PASSWORD" \
  -o output.mp4 \
  "https://<your-app>.onrender.com/api/download/5f2c.../file?password=YOUR_PASSWORD"
```

---

## 5. なぜジョブ方式（ポーリング）にしているか

Render の Web サービスにはリクエストのタイムアウトがあり、1080p以上の動画を
その場でダウンロード＆結合して返そうとすると、処理中にタイムアウトしてしまう
ことがあります。

そのため、このサーバーは「ジョブを登録 → バックグラウンドで yt-dlp/ffmpeg 処理 →
完了したらファイルを取得」という非同期方式にしています。これにより：

- 1本のHTTPリクエストが長時間ブロックされない
- 進捗をポーリングで確認できる
- 将来的に処理部分だけ Render の **Background Worker** サービスとして
  切り出すことも容易（下記6章）

---

## 6. Render の Background Worker として分離したい場合

現状は同一プロセス内で「APIサーバー」と「ダウンロード処理」を両方行っています
（個人利用・単一インスタンス前提のシンプルな構成）。

アクセスが増えて処理を分離したくなった場合は、以下のような構成に拡張できます。

1. `processDownloadJob` 相当の処理を、キュー（Redis の List など）から
   ジョブを取り出して実行する別スクリプト（例: `worker.js`）に切り出す
2. Render で **New → Background Worker** を作成し、同じ Dockerfile / リポジトリを指定、
   起動コマンドだけ `node worker.js` に変更する
3. Web サービス側は `POST /api/download` でジョブをキューに積むだけにする
4. ジョブの状態は Redis や DB に保存し、Web / Worker 両方から参照できるようにする

個人利用でアクセスが自分だけなら、現状のインプロセス方式のままで十分動作します。

---

## 7. トラブルシューティング

- **「画質一覧の取得に失敗しました」** : YouTube 側の仕様変更や年齢制限・地域制限がある
  可能性があります。yt-dlp のバージョンアップで直ることが多いので、Dockerfile の
  `pip3 install --no-cache-dir -U yt-dlp` により毎回最新版が入るようにしています。
  それでも直らない場合は再デプロイ（キャッシュなしビルド）を試してください。
- **ダウンロードが途中で `error` になる** : `status` の `error` メッセージに ffmpeg / yt-dlp
  のエラー内容が入っているので確認してください。無料プランはディスク容量・メモリが
  少ないため、長時間の高画質動画では不足する場合があります。
- **401 Unauthorized** : `API_PASSWORD` とクライアント側で送っているパスワードが
  一致しているか確認してください。
