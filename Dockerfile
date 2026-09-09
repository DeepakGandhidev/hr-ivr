# Development image for the whole monorepo.
#
# One image, two entry points: the Next.js app and the voice worker both run
# from the same install, because they share three workspace packages and
# building them separately means installing the same tree twice.
#
# Debian rather than Alpine: pdf-parse and imapflow pull native-ish deps that
# are a known source of musl surprises, and a colleague debugging a CV parser
# should not first have to debug their base image.
FROM node:22-bookworm-slim

# openssl is required by Prisma's query engine; it is not in the slim image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first, so a source edit does not invalidate the install layer.
COPY package.json package-lock.json ./
COPY apps/web/package.json        apps/web/
COPY apps/worker/package.json     apps/worker/
COPY packages/prisma/package.json packages/prisma/
COPY packages/shared/package.json packages/shared/

RUN npm ci

COPY . .

# Both are generated, both are gitignored, and both are imported at runtime -
# so without this the first request fails on a missing module rather than on
# anything the developer did.
RUN npx prisma generate --schema packages/prisma/schema.prisma \
 && npm run build -w @pratibha/shared

EXPOSE 3000 8091
