import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api/v1';

export interface CreateSessionRequest {
  name: string;
  email: string;
  mobile: string;
  persona: string;
}

export interface CreateSessionResponse {
  success: boolean;
  data: {
    sessionId: string;
    status: string;
    createdAt: string;
  };
}

export const createSession = async (data: CreateSessionRequest): Promise<CreateSessionResponse> => {
  const response = await axios.post<CreateSessionResponse>(`${API_BASE_URL}/sessions`, data);
  return response.data;
};

export const getSession = async (sessionId: string) => {
  const response = await axios.get(`${API_BASE_URL}/sessions/${sessionId}`);
  return response.data;
};

export const endSession = async (sessionId: string) => {
  const response = await axios.post(`${API_BASE_URL}/sessions/${sessionId}/end`);
  return response.data;
};

