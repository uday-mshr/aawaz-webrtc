import { z } from 'zod';
import { Persona } from '../types/persona.types';

// Email validation regex
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mobile validation - accepts digits, spaces, hyphens, parentheses, and + sign
const mobileRegex = /^[\d\s\-\+\(\)]+$/;

export const createSessionSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),
  email: z.string()
    .min(1, 'Email is required')
    .email('Invalid email format')
    .regex(emailRegex, 'Invalid email format')
    .toLowerCase()
    .trim(),
  mobile: z.string()
    .min(1, 'Mobile number is required')
    .max(20, 'Mobile number must be less than 20 characters')
    .regex(mobileRegex, 'Invalid mobile number format')
    .trim(),
  persona: z.nativeEnum(Persona, {
    errorMap: () => ({ message: 'Invalid persona. Must be one of: restaurant_receptionist, university_admission_counsellor, clinic_receptionist' })
  })
});

export const sessionIdParamSchema = z.object({
  sessionId: z.string()
    .uuid('Invalid session ID format')
    .min(1, 'Session ID is required')
});

export const updateSessionStateSchema = z.object({
  conversationState: z.object({
    intent: z.enum(['table_booking', 'takeaway', 'extend_booking', 'general_query']).nullable().optional(),
    bookingDetails: z.object({
      date: z.string().optional(),
      time: z.string().optional(),
      guests: z.number().int().positive().optional(),
      specialRequests: z.string().optional(),
      confirmed: z.boolean().optional()
    }).optional(),
    orderDetails: z.object({
      items: z.array(z.object({
        name: z.string(),
        quantity: z.number().int().positive()
      })).optional(),
      total: z.number().nonnegative().optional(),
      confirmed: z.boolean().optional()
    }).optional(),
    callbackScheduled: z.object({
      scheduledAt: z.coerce.date(),
      reason: z.string()
    }).optional()
  }).optional(),
  status: z.enum(['active', 'ended']).optional()
}).partial();

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type SessionIdParam = z.infer<typeof sessionIdParamSchema>;
export type UpdateSessionStateInput = z.infer<typeof updateSessionStateSchema>;

