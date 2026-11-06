import { z } from 'zod';
import { RecipientParseResult } from './types.js';

export const emailAddressRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ComposeEmailSchema = z.object({
  senderId: z.string().uuid({ message: 'Valid sender account must be selected' }),
  subject: z.string().trim().min(1, 'Subject is required').max(255, 'Subject cannot exceed 255 characters'),
  body: z.string().trim().min(1, 'Email body is required').max(200_000, 'Message is too long'),
  recipients: z.array(z.string().regex(emailAddressRegex, 'Invalid email address')).min(1, 'At least one valid recipient is required'),
  ccRecipients: z.array(z.string().regex(emailAddressRegex, 'Invalid Cc email address')).max(100).default([]),
  bccRecipients: z.array(z.string().regex(emailAddressRegex, 'Invalid Bcc email address')).max(100).default([]),
  attachments: z.array(z.object({
    fileName: z.string().trim().min(1).max(180),
    contentType: z.string().trim().regex(/^[\w.+-]+\/[\w.+-]+$/, 'Choose a valid file type').max(120),
    size: z.number().int().positive().max(10 * 1024 * 1024),
    contentBase64: z.string().min(1).max(14 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    inline: z.boolean().default(false),
    contentId: z.string().regex(/^[\da-f-]{36}$/i).optional(),
  }).superRefine((attachment, context) => {
    if (attachment.inline && !attachment.contentId) context.addIssue({ code: z.ZodIssueCode.custom, path: ['contentId'], message: 'Inline images need a content identifier.' });
    if (attachment.inline && !attachment.contentType.startsWith('image/')) context.addIssue({ code: z.ZodIssueCode.custom, path: ['contentType'], message: 'Inline content must be an image.' });
  })).max(10).default([]),
  scheduledAt: z.string().datetime({ message: 'Scheduled time must be a valid ISO datetime' }),
  delayBetweenSeconds: z.number().int().min(0).max(3600).default(2),
  hourlyLimit: z.number().int().min(1).max(5000).default(50),
}).superRefine((input, context) => {
  const totalSize = input.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (totalSize > 10 * 1024 * 1024) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['attachments'], message: 'Attachments must total 10 MB or less.' });
  }
});

export type ComposeEmailInput = z.infer<typeof ComposeEmailSchema>;

export const RescheduleEmailSchema = z.object({
  scheduledAt: z.string().datetime({ message: 'Choose a valid schedule date and time.' }),
});

export type RescheduleEmailInput = z.infer<typeof RescheduleEmailSchema>;

export const CreateSenderSchema = z.object({
  email: z.string().trim().toLowerCase().regex(emailAddressRegex, 'Valid sender email address required'),
  name: z.string().trim().min(1, 'Sender name is required').max(100),
  hourlyLimit: z.number().int().min(1).max(5000).default(50),
});

export type CreateSenderInput = z.infer<typeof CreateSenderSchema>;

/**
 * Utility to parse recipients from raw text (CSV, newline-separated, or comma-separated)
 */
export function parseRecipientsList(rawInput: string): RecipientParseResult {
  const tokens = rawInput
    .split(/[\r\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const seen = new Set<string>();
  const validEmails: string[] = [];
  const invalidEntries: string[] = [];

  for (const token of tokens) {
    const cleaned = token.replace(/^["']|["']$/g, '').trim().toLowerCase();
    if (emailAddressRegex.test(cleaned)) {
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        validEmails.push(cleaned);
      }
    } else {
      invalidEntries.push(token);
    }
  }

  return {
    validEmails,
    invalidEntries,
    totalParsed: tokens.length,
  };
}

