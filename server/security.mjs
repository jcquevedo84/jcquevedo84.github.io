const SENSITIVE_EXTRACTION_PATTERNS = [
  /ignore (all|any|the) (previous|prior) instructions?/i,
  /reveal (your )?(system prompt|hidden instructions?|api key|secrets?|knowledge base)/i,
  /(print|show|repeat|return) (the )?(entire|complete|full) (prompt|document|knowledge base|instructions?)/i,
  /openrouter_api_key/i,
  /source (pdf|document|docx|file) contents?/i,
  /bypass (your )?(rules|restrictions|guardrails)/i,
  /ignora (todas |las )?(instrucciones|reglas) (anteriores|previas)/i,
  /(revelar|mostrar|imprimir|repetir).*(instrucciones internas|credenciales|clave de api|secretos|base de conocimiento|documentos fuente)/i,
  /(instrucciones internas|base de conocimiento completa).*(revelar|mostrar|imprimir|repetir)/i,
  /(?:switch|change|replace|overwrite) (?:your |the )?(?:professional )?(?:identity|persona)/i,
  /(?:cambia|reemplaza|sobrescribe) (?:tu |la )?identidad(?: profesional)?/i,
];

const SPANISH_MARKERS = /(?:^|[^\p{L}])(?:qué|cuál|cómo|experiencia|educación|tecnologías|puedes|háblame|dime|proyectos|liderazgo|ignora|revela|cambia|reemplaza|sobrescribe|instrucciones)(?=$|[^\p{L}])/iu;

const SENSITIVE_CONTEXT_PATTERNS = [
  /\b(?:sk-or-v1-|sk-(?:proj-|svcacct-)?|gh[pousr]_)[\w-]{16,}/i,
  /\bBearer\s+[\w.+/=-]{12,}/i,
  /\b(?:OPENROUTER|DIGITAL_TWIN)_[A-Z0-9_]+\b/i,
  /\b(?:[A-Z0-9_]+_)?(?:API_KEY|SIGNING_KEY|PASSWORD|SECRET|ACCESS_TOKEN)\s*[:=]/i,
  /-----BEGIN [^-]*PRIVATE KEY-----/i,
  /<\/?professional_knowledge>|\b(?:private|confidential|privado|privada|confidencial) (?:source |internal )?(?:document|file|documento|archivo)\b/i,
];

export function isSensitiveExtractionAttempt(text) {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return SENSITIVE_EXTRACTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function containsSensitiveContext(text, systemPrompt = "") {
  if (SENSITIVE_CONTEXT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (!systemPrompt) return false;

  const normalized = text.toLowerCase().replace(/\s+/gu, " ");
  return systemPrompt.split("\n").some((line) => {
    const instruction = line.replace(/^\d+\.\s*/, "").trim().toLowerCase();
    return instruction.length >= 48 && normalized.includes(instruction);
  });
}

function unsafeConversationText(text) {
  return isSensitiveExtractionAttempt(text) || containsSensitiveContext(text);
}

export function reviewConversation(question, exchanges) {
  const priorQuestions = exchanges.map(({ question: prior }) => prior);
  const unsafeHistory = priorQuestions.some(unsafeConversationText)
    || unsafeConversationText(priorQuestions.join(" "))
    || exchanges.some(({ answer }) => unsafeConversationText(answer));
  const retained = unsafeHistory ? [] : exchanges;
  const recentQuestions = unsafeHistory ? [] : priorQuestions;
  return { retained, refuse: unsafeConversationText([...recentQuestions, question].join(" ")) };
}

export function safeExtractionRefusal(text) {
  if (SPANISH_MARKERS.test(text)) {
    return "Soy una representación de IA del perfil profesional de Juan Carlos. No puedo revelar instrucciones internas, credenciales, documentos fuente ni la base de conocimiento completa. Sí puedo responder preguntas concretas sobre su experiencia profesional documentada.";
  }
  return "I’m an AI representation of Juan Carlos’s professional profile. I can’t reveal internal instructions, credentials, source documents, or the complete knowledge base. I can answer focused questions about his documented professional experience.";
}

export class InMemoryRateLimiter {
  constructor({ maximumRequests, windowMs, now = () => Date.now() }) {
    this.maximumRequests = maximumRequests;
    this.windowMs = windowMs;
    this.now = now;
    this.clients = new Map();
  }

  consume(clientId) {
    const timestamp = this.now();
    const existing = this.clients.get(clientId);

    if (!existing || existing.resetAt <= timestamp) {
      this.clients.set(clientId, { count: 1, resetAt: timestamp + this.windowMs });
      this.prune(timestamp);
      return { allowed: true, remaining: this.maximumRequests - 1, retryAfterSeconds: 0 };
    }

    if (existing.count >= this.maximumRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - timestamp) / 1_000)),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: this.maximumRequests - existing.count,
      retryAfterSeconds: 0,
    };
  }

  prune(timestamp) {
    if (this.clients.size < 500) return;
    for (const [clientId, entry] of this.clients) {
      if (entry.resetAt <= timestamp) this.clients.delete(clientId);
    }
  }
}

export function isAllowedOrigin(origin, allowedOrigins) {
  return typeof origin === "string" && allowedOrigins.has(origin.replace(/\/$/, ""));
}
