# 個人用 YouTube ダウンロードサーバー用 Dockerfile
# Node.js + Python3(yt-dlp) + ffmpeg をまとめて用意する

FROM node:20-bullseye-slim

# yt-dlp (Python製) と ffmpeg、証明書類をインストール
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-pip \
        ffmpeg \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp は pip で最新版を入れる（バイナリより更新が容易なため）
RUN pip3 install --no-cache-dir -U yt-dlp

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
