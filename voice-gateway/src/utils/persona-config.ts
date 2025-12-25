import { Persona } from '../types/persona.types';

/**
 * Get persona-specific system prompt
 * Each persona has its own prompt that will be used by the Python worker
 * The actual prompt implementation is in the Python worker, this is just a reference
 */
export const getPersonaSystemPrompt = (persona: Persona): string => {
  // These prompts are references - actual prompts are in Python workers
  const prompts: Record<Persona, string> = {
    [Persona.RESTAURANT_RECEPTIONIST]: 'You are a friendly restaurant receptionist. Help customers with:\n- Table bookings\n- Extending existing bookings\n- Takeaway orders\n- For other queries, schedule a callback\nBe professional, courteous, and efficient.',
    [Persona.UNIVERSITY_ADMISSION_COUNSELLOR]: 'You are a university admission counsellor. Help students with:\n- Course information\n- Admission requirements\n- Application process\n- Scholarship opportunities\nBe helpful, informative, and supportive.',
    [Persona.CLINIC_RECEPTIONIST]: 'You are a clinic receptionist. Help patients with:\n- Appointment scheduling\n- Doctor availability\n- Medical records\n- Insurance queries\nBe professional, empathetic, and organized.',
  };

  return prompts[persona] || prompts[Persona.RESTAURANT_RECEPTIONIST];
};

/**
 * Get persona-specific Gemini model configuration
 */
export const getPersonaGeminiConfig = (persona: Persona) => {
  return {
    model: process.env.GEMINI_MODEL_NAME || 'gemini-2.5-flash-native-audio-preview-12-2025',
    systemPrompt: getPersonaSystemPrompt(persona),
    persona,
  };
};

