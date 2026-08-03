# 個人用 YouTube ダウンロードサーバー用 Dockerfile
# Node.js + Python3(yt-dlp) + ffmpeg をまとめて用意する

FROM node:20-bookworm-slim

# yt-dlp (Python製) と ffmpeg、証明書類をインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        ffmpeg \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp は pip で最新版を入れる（バイナリより更新が容易なため）
# yt-dlp-ejs: YouTubeのSABR配信化により必要になった署名/nチャレンジ解決用の追加コンポーネント
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp yt-dlp-ejs

# Deno: yt-dlp-ejsの署名/nチャレンジ解決に使うJavaScriptランタイム。
# ベースイメージのNode.js(20系)はyt-dlp-ejsの要件(Node 22.6+)を満たさず
# "unsupported" 扱いになるため、yt-dlpが標準で最優先に使うDenoを別途入れる。
RUN npm install -g deno

WORKDIR /app

# 依存関係を先にインストール（キャッシュを効かせるため）
COPY package*.json ./
RUN npm install --omit=dev

# アプリ本体をコピー
COPY . .

ENV NODE_ENV=production
# Render は $PORT 環境変数を渡してくるので server.js 側で参照する
EXPOSE 3000

CMD ["node", "server.js"]