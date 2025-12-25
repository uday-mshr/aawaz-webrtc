# Simple Node-based image to run Vite dev server
FROM node:20-alpine

WORKDIR /app

# Accept build arguments for Vite environment variables
ARG VITE_API_URL=http://localhost:3000/api/v1
ARG VITE_SOCKET_URL=http://localhost:3000

# Set as environment variables (Vite reads from process.env at build time)
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_SOCKET_URL=$VITE_SOCKET_URL

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

EXPOSE 5173

# Run Vite dev server (adjust to build/serve in prod if needed)
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

