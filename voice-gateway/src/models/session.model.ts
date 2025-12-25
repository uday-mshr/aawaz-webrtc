import mongoose, { Schema, Document } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { Persona } from '../types/persona.types';

export interface ConversationState {
  intent?: 'table_booking' | 'takeaway' | 'extend_booking' | 'general_query' | null;
  bookingDetails?: {
    date?: string;
    time?: string;
    guests?: number;
    specialRequests?: string;
    confirmed?: boolean;
  };
  orderDetails?: {
    items?: Array<{ name: string; quantity: number }>;
    total?: number;
    confirmed?: boolean;
  };
  callbackScheduled?: {
    scheduledAt: Date;
    reason: string;
  };
}

export interface SessionDocument extends Document {
  sessionId: string;
  persona: Persona;
  userInfo: {
    name: string;
    email: string;
    mobile: string;
  };
  connectionType: 'web';
  socketId?: string;
  status: 'active' | 'ended' | 'timeout';
  conversationState: ConversationState;
  geminiConfig: {
    model: string;
    systemPrompt: string;
    persona: Persona;
  };
  metadata: {
    userAgent?: string;
    ipAddress?: string;
  };
  createdAt: Date;
  updatedAt: Date;
  endedAt?: Date;
  duration?: number; // in seconds
}

const ConversationStateSchema = new Schema({
  intent: {
    type: String,
    enum: ['table_booking', 'takeaway', 'extend_booking', 'general_query', null],
    default: null
  },
  bookingDetails: {
    date: String,
    time: String,
    guests: Number,
    specialRequests: String,
    confirmed: Boolean
  },
  orderDetails: {
    items: [{
      name: String,
      quantity: Number
    }],
    total: Number,
    confirmed: Boolean
  },
  callbackScheduled: {
    scheduledAt: Date,
    reason: String
  }
}, { _id: false });

const SessionSchema = new Schema<SessionDocument>(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      default: () => uuidv4(),
      index: true
    },
    persona: {
      type: String,
      enum: Object.values(Persona),
      required: true,
      index: true
    },
    userInfo: {
      name: {
        type: String,
        required: true,
        trim: true
      },
      email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        index: true
      },
      mobile: {
        type: String,
        required: true,
        trim: true
      }
    },
    connectionType: {
      type: String,
      enum: ['web'],
      default: 'web'
    },
    socketId: {
      type: String,
      index: true
    },
    status: {
      type: String,
      enum: ['active', 'ended', 'timeout'],
      default: 'active',
      index: true
    },
    conversationState: {
      type: ConversationStateSchema,
      default: () => ({})
    },
    geminiConfig: {
      model: {
        type: String,
        default: process.env.GEMINI_MODEL_NAME || 'gemini-2.5-flash-native-audio-preview-12-2025'
      },
      systemPrompt: {
        type: String,
        default: '' // Will be set by persona-specific configuration
      },
      persona: {
        type: String,
        enum: Object.values(Persona),
        required: true
      }
    },
    metadata: {
      userAgent: String,
      ipAddress: String
    },
    endedAt: Date,
    duration: Number
  },
  {
    timestamps: true,
    collection: 'sessions'
  }
);

// Indexes for performance
SessionSchema.index({ createdAt: -1 });
SessionSchema.index({ status: 1, createdAt: -1 });
SessionSchema.index({ persona: 1, status: 1 }); // For querying active sessions by persona

// Calculate duration before saving if session is ended
SessionSchema.pre('save', function (next) {
  if (this.isModified('status') && this.status === 'ended' && this.endedAt && this.createdAt) {
    this.duration = Math.floor((this.endedAt.getTime() - this.createdAt.getTime()) / 1000);
  }
  next();
});

export const Session = mongoose.model<SessionDocument>('Session', SessionSchema);

