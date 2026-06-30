FROM node:20-bookworm-slim

# LibreOffice (WMF/EMF/DOC -> PNG/DOCX conversion) and ImageMagick (PNG trimming)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    imagemagick \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# ImageMagick 6 on Debian ships a security policy that blocks reading some
# formats by default; PNG read/write is fine out of the box, so no policy
# changes are needed here. (Left as a comment in case future formats are added.)

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

ENV PORT=8787
EXPOSE 8787

CMD ["node", "src/server.js"]
