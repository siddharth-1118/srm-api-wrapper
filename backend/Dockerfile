# Use the official Playwright image which has Chromium and all dependencies pre-installed
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm ci

# Copy code
COPY . .

# Compile TypeScript to JavaScript
RUN npm run build

# Render uses port 5000
EXPOSE 5000

ENV PORT=5000
ENV NODE_ENV=production

CMD ["npm", "start"]
