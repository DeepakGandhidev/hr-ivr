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
      if (code !== 'H7K294') return { valid: false, reason: 'invalid_code' };
      return {
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
      };
    }
    if (method === 'POST' && path === '/api/v1/pratibha/calls') return { id: 7001 };
    return { ok: true };
  }
}
