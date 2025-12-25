import mongoose from 'mongoose';
import logger from '../utils/logger';

class Database {
  private uri: string;

  constructor() {
    this.uri = process.env.MONGO_URI || 'mongodb://localhost:27017/default';
  }

  async connect(): Promise<void> {
    try {
      await mongoose.connect(this.uri);
      logger.info('Connected to MongoDB', { uri: this.uri });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('MongoDB connection failed', { error: message });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await mongoose.disconnect();
      logger.info('Disconnected from MongoDB');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error('MongoDB disconnection failed', { error: message });
    }
  }
}

export default new Database();
