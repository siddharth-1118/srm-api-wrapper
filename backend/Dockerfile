# Use the official Playwright image which has Chromium and all dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.62.1-jammy

WORKDIR /app

# Copy package files from the backend directory
COPY backend/package*.json ./

# Install npm dependencies (pinned versions)
RUN npm ci

# Install the exact matching browser binaries for the installed playwright version
RUN npx playwright install chromium

# Copy the rest of the backend files
COPY backend/ ./

# Compile TypeScript to JavaScript
RUN npm run build

# Render uses port 5000
EXPOSE 5000

ENV PORT=5000
ENV NODE_ENV=production

CMD ["npm", "start"]
