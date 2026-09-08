export const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceInr: 4999,
    limits: { roles: 2, interviews: 15, screenings: 100 },
    features: {},
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceInr: 12999,
    limits: { roles: 6, interviews: 60, screenings: 400 },
    features: { portalAutoPosting: true, protocolTuning: true },
  },
  scale: {
    id: 'scale',
    name: 'Scale',
    priceInr: 29999,
    limits: { roles: null, interviews: 200, screenings: 1500 },
    features: { portalAutoPosting: true, protocolTuning: true, dedicatedDid: true, apiAccess: true },
  },
} as const;

export const TRIAL_DAYS = 15;

export const TRIAL_LIMITS = {
  jobs: 1,
  interviews: 5,
  screenings: 25,
} as const;

export const OVERAGE_RATES = {
  interviewInr: 149,
  screeningInr: 5,
} as const;

export const DEFAULT_SCREENING_THRESHOLD = 70;

export const SUPPORTED_LANGUAGES = ['en', 'hi', 'hinglish'] as const;
