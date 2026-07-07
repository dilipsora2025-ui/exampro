# Render's default Node buildpack does NOT include LibreOffice, and this service
# needs the real "soffice" binary to convert legacy WMF/EMF equation previews
# into PNGs — so this must be deployed as a Docker service on Render (New +
# -> Web Service -> pick "Docker" as the environment; Render auto-detects this
# Dockerfile, no extra config needed).

FROM node:20-slim

# libreoffice-writer pulls in the core + draw filters we need for wmf/emf -> png.
# --no-install-recommends keeps the image reasonably small (~500MB instead of ~1GB).
RUN apt-get update && \
    apt-get install -y --no-install-recommends libreoffice-writer && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=4000
EXPOSE 4000
CMD ["node", "server.js"]
