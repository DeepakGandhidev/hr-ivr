import axios from 'axios';
import { createHMACSignature } from '../utils/hmac.js';

/**
 * Client for the Jobs module in ProMonkey OS. Every candidate fact Pratibha
 * relies on - the invite, the CV, the rubric - comes from here, and every
 * durable record of the call goes back here.
 *
 * Deliberately absent: any method that places a call. Section 3.1 forbids
 * outbound entirely, and the cheapest way to keep that true as the code grows
 * is to never give the codebase the ability in the first place. The guardrail
 * test asserts it.
 */
/**
 * Mock invites, used only when MOCK_MODE=true. Keyed by the reference code a
 * caller reads out. Add a candidate here and `npm run simulate` can screen them
 * without ProMonkey OS, Plivo or a phone line being involved.
 *
 * These are invented people. Nothing here is a real candidate, and the shape
 * deliberately carries no email or phone number - Pratibha never needs either,
 * and 3.6 is easier to honour if the data is not in the process to begin with.
 */
const MOCK_INVITES = {
  H7K294: {
    valid: true,
    invite: { id: 9001, reference_code: 'H7K294', status: 'active', expires_at: '2026-09-06T18:30:00Z' },
    candidate: {
      id: 501,
      full_name: 'Ananya Rao',
      first_name: 'Ananya',
      total_experience_years: 6,
      current_employer: 'Infosys',
      current_designation: 'Senior Backend Engineer',
      notice_period: '60 days',
      cv_summary: 'Six years of Node.js and Java backend work. Led a team of four on a payments integration. Two production API integrations in portfolio. No AWS experience evidenced.'
    },
    job: {
      id: 12,
      title: 'Senior Backend Engineer',
      jd_summary: 'Backend depth in Node.js, API design, mentoring juniors, AWS desirable.'
    },
    criteria: [
      { id: 1, criterion: 'Backend depth in Node.js', weight: 5, evaluation_guidance: 'Probe concrete production work, not tutorials.' },
      { id: 2, criterion: 'API design and integration', weight: 4, evaluation_guidance: 'Ask about a specific integration they owned.' },
      { id: 3, criterion: 'Mentoring and team leadership', weight: 3, evaluation_guidance: 'The CV claims a team of four - test it.' }
    ],
    protocols: []
  },

  // A junior full-stack CV that leads on real-time infrastructure and is dense
  // with self-reported percentages. Useful as a fixture precisely because the
  // headline numbers have no baseline attached: it gives the evidence checks in
  // analysis.js something to actually fail on.
  K3M581: {
    valid: true,
    invite: { id: 9002, reference_code: 'K3M581', status: 'active', expires_at: '2026-09-12T18:30:00Z' },
    candidate: {
      id: 502,
      full_name: 'Rohan Malhotra',
      first_name: 'Rohan',
      total_experience_years: 2,
      current_employer: 'Northline Systems',
      current_designation: 'Full Stack Developer',
      notice_period: '30 days',
      cv_summary: 'Two years full-stack. Node.js and Express on the back end, React and Next.js on the front. Current work is a one-to-one voice and video calling platform on a managed cloud communications service, plus an MVP for live speech translation across 120+ languages. Claims a microservices split that raised throughput 40%, a Redis and Socket.IO presence layer that cut database queries 60%, and sub-500ms translation latency. Kubernetes, Docker and multi-cloud deployment listed. Every figure is self-reported with no baseline stated.'
    },
    job: {
      id: 14,
      title: 'Full Stack Developer',
      jd_summary: 'Node.js and React depth, real-time systems, sensible data modelling, comfortable deploying to cloud infrastructure.'
    },
    criteria: [
      { id: 1, criterion: 'Real-time systems depth', weight: 5, evaluation_guidance: 'The CV leads on live audio and video. Separate what they built from what the managed service gave them for free.' },
      { id: 2, criterion: 'Backend and service architecture', weight: 4, evaluation_guidance: 'Claims 40% higher throughput from a microservices split. Ask what was measured and against what baseline.' },
      { id: 3, criterion: 'Data layer and caching', weight: 3, evaluation_guidance: 'Claims 60% fewer queries from Redis-backed presence. Have them describe the write path.' },
      { id: 4, criterion: 'Frontend proficiency', weight: 3, evaluation_guidance: 'React and Next.js are listed prominently but the described work is backend. Establish which they actually own.' }
    ],
    protocols: []
  }
};

export class OsApi {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.mock = config.mockMode;
    this.http = axios.create({
      baseURL: config.os.apiBase,
      timeout: config.os.timeoutMs,
      headers: { Authorization: `Bearer ${config.os.serviceToken}` }
    });
  }

  async #request(method, path, body, extraHeaders = {}) {
    if (this.mock) return this.#mockResponse(method, path, body);

    const headers = { ...extraHeaders };
    if (body) headers['X-HMAC-Signature'] = createHMACSignature(body, this.config.os.hmacSecret);

    const { data } = await this.http.request({ method, url: path, data: body, headers });
    return data;
  }

  /**
   * 3.7 - the only gate onto the line. Returns why a code failed so Pratibha
   * can say the right thing, but never returns candidate details for a code
   * that did not validate.
   */
  async lookupInvite(code) {
    const normalised = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!normalised) return { valid: false, reason: 'no_code' };
    return this.#request('GET', `/api/v1/pratibha/invites/${encodeURIComponent(normalised)}`);
  }

  /** Opens the ScreeningCall row. Recording is NOT started here - 3.3. */
  async startCall(payload) {
    return this.#request('POST', '/api/v1/pratibha/calls', payload, {
      'Idempotency-Key': payload.telephony_call_id
    });
  }

  async updateCall(callId, patch) {
    return this.#request('PATCH', `/api/v1/pratibha/calls/${callId}`, patch);
  }

  async saveTranscript(callId, segments) {
    return this.#request('POST', `/api/v1/pratibha/calls/${callId}/transcript`, { segments });
  }

  /**
   * 3.5 - scores must cite a rubric criterion and an evidence quote, and 3.4 -
   * nothing here may set an application to rejected. The API rejects a payload
   * that breaks either rule; this method does not attempt to work around that.
   */
  async saveAnalysis(callId, analysis) {
    return this.#request('POST', `/api/v1/pratibha/calls/${callId}/analysis`, analysis);
  }

  /** Callers with no valid code. Section 5, CallLogUnmatched. */
  async logUnmatched(payload) {
    return this.#request('POST', '/api/v1/pratibha/unmatched-calls', payload);
  }

  /**
   * 8.6 - a candidate asked for a human, or the call went wrong. Notifies the
   * escalation owner. It does not dial anyone; a human calls from their own
   * phone if they choose to.
   */
  async escalate(payload) {
    return this.#request('POST', '/api/v1/pratibha/escalations', payload);
  }

  #mockResponse(method, path, body) {
    this.logger.info({ method, path, body }, 'mock OS API call');

    if (method === 'GET' && path.includes('/invites/')) {
      const code = decodeURIComponent(path.split('/').pop());
      if (code === 'EXPIRD') return { valid: false, reason: 'expired_code' };
      return MOCK_INVITES[code] || { valid: false, reason: 'invalid_code' };
    }
    if (method === 'POST' && path === '/api/v1/pratibha/calls') return { id: 7001 };
    return { ok: true };
  }
}
