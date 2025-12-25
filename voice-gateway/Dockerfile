# Use Node.js 22.11.0 Alpine image
FROM node:22.11.0-alpine

# Set the working directory
WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package.json and package-lock.json to install dependencies
COPY package*.json ./

# Install all dependencies (including dev dependencies)
RUN npm install

# Rebuild native modules for Alpine (musl) environment
RUN npm rebuild bcrypt --build-from-source

# Copy the rest of the application source code
COPY . .

# Expose the application port
EXPOSE 3000

# Install nodemon and ts-node globally for watching changes
RUN npm install -g nodemon ts-node

# Start the application in development mode with npm script
CMD ["npm", "run", "dev"]