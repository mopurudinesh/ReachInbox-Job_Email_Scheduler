export enum EmailStatus {
  SCHEDULED = 'SCHEDULED',
  QUEUED = 'QUEUED',
  PROCESSING = 'PROCESSING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  DEFERRED = 'DEFERRED',
  UNKNOWN = 'UNKNOWN',
  CANCELLED = 'CANCELLED',
}

export enum SenderStatus {
  ACTIVE = 'ACTIVE',
  DISCONNECTED = 'DISCONNECTED',
  PAUSED = 'PAUSED',
}

export enum IntegrationType {
  SLACK = 'SLACK',
  GOOGLE = 'GOOGLE',
}

