# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lockb /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json bun.lockb /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory
# then copy all (non-ignored) project files into the image
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY . .

# Run Prisma generate
RUN bunx prisma generate
#test
# [optional] tests & build
ENV NODE_ENV=production
RUN bun test
RUN bun run build

# copy production dependencies and source code into final image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/server.ts .
COPY --from=prerelease /usr/src/app/db.ts .
COPY --from=prerelease /usr/src/app/package.json .
# Copy Prisma schema and generated client
COPY --from=prerelease /usr/src/app/prisma ./prisma
COPY --from=prerelease /usr/src/app/node_modules/.prisma ./node_modules/.prisma
# Also copy the utils directory which contains logger.ts
COPY --from=prerelease /usr/src/app/utils ./utils

# run the app
USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "server.ts" ]