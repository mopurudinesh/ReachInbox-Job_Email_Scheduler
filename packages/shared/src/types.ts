import { EmailStatus, SenderStatus } from './enums.js';

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  createdAt: string;
}

export interface SenderAccountDTO {
  id: string;
  userId: string;
  email: string;
  name: string;
  hourlyLimit: number;
  status: SenderStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RecipientParseResult {
  validEmails: string[];
  invalidEntries: string[];
  totalParsed: number;
}

export interface EmailJobPayload {
  emailId: string;
  recipientId: string;
  senderId: string;
  userId: string;
  recipientEmail: string;
  subject: string;
  body: string;
  attemptNumber: number;
  scheduledFor: string;
}

export interface EmailSearchItem {
  id: string;
  recipientEmail: string;
  senderEmail: string;
  senderName: string;
  subject: string;
  bodyText: string;
  status: EmailStatus;
  scheduledAt: string;
  sentAt?: string | null;
  errorMessage?: string | null;
}

export interface EmailSearchDocument extends EmailSearchItem {
  userId: string;
  campaignId: string;
  scheduledAt: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

