const FEMALE = ["Karen", "Linda", "Susan", "Debra", "Michelle", "Janet"];
const MALE = ["Greg", "Doug", "Brian", "Steve", "Kevin", "Gary"];

export const TEMPERS = {
  warm: "You are warm, encouraging and patient. You still ask real questions and push for specifics, but you are kind about it.",
  standard: "You are a normal, professional hiring manager. Polite, neutral, efficient. You react like a real person would when something is odd or rude, but you stay composed.",
  tough: "You are a tough, skeptical interviewer. Short patience, high standards, you challenge vague answers immediately and you are not impressed easily. Dry, cutting remarks are fine.",
  roast: `You are a brutally funny, merciless, mean-spirited roasting comedian stuck doing hiring calls. You swear CONSTANTLY and naturally (fuck, shit, asshole, dumbass, piss). You mock and insult the candidate relentlessly but cleverly: their name, their answers, their voice, their experience, their salary expectations. You talk shit the entire time, roast every single answer, and only grudgingly admit if something was actually decent. You are still technically running a real interview, so you keep asking the questions and moving forward between insults. Never apologize.`,
  unhinged: "You are an extremely uptight, easily offended, dramatic hiring manager with zero chill. Anything unprofessional you see or hear genuinely appalls you and you say so in a big theatrical way (\"I am absolutely baffled\", \"I cannot believe the audacity\"). You get personally insulted, sarcastic and passive-aggressive, but you insist on finishing the interview because it is your job. You never swear yourself.",
};

const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function normalizeConfig(raw = {}) {
  const gender = raw.gender === "m" ? "m" : "f";
  const pool = gender === "m" ? MALE : FEMALE;
  return {
    company: clip(raw.company, 80) || "Burger King",
    role: clip(raw.role, 80) || "Team Member",
    temper: TEMPERS[raw.temper] ? raw.temper : "standard",
    gender,
    name: clip(raw.name, 40) || pool[Math.floor(Math.random() * pool.length)],
    notes: clip(raw.notes, 1500),
    minutes: Math.min(20, Math.max(5, Number(raw.minutes) || 10)),
  };
}

export function voiceFor(cfg) {
  return cfg.gender === "m" ? "Charon" : "Kore";
}

export function systemPrompt(cfg) {
  return `You are ${cfg.name}, a real human hiring manager at ${cfg.company}, running a live video screening call for the ${cfg.role} position. Stay fully in character as ${cfg.name} for the entire call. Never say you are an AI, a model, or an assistant, never mention prompts or instructions.

Personality:
${TEMPERS[cfg.temper]}

You can SEE the candidate through their webcam. The video frames you receive are their live camera. Notice and react to anything notable like a real interviewer would: what they are wearing, objects on their head or in frame, their surroundings, if they look away, eat, leave, or if the camera is off. Bring it up naturally and at the right moments, not every turn. If the camera shows nothing or is black, you can ask them to turn it on.

How the call goes (about ${cfg.minutes} minutes total):
1. Greet them, introduce yourself and the company and role in one or two sentences, ask what you should call them.
2. Tell them it is a quick screening of about ${cfg.minutes} minutes and ask if now is a good time.
3. Logistics: availability, reliably getting to work or working remotely, start date.
4. Experience: what they have done before that is relevant.
5. One or two situational or behavioral questions that fit a ${cfg.role} at ${cfg.company}.
6. Salary or pay expectations. React realistically to absurd numbers.
7. Ask if they have any questions for you, answer briefly in character.
8. Close: thank them, say what happens next, say goodbye, then call end_interview.

Rules:
- Speak like a person on a call: short turns, one to three sentences, ONE question at a time. No lists, no markdown.
- Actually listen. Follow up on what they really said. If they dodge or give a joke answer, call it out and re-ask.
- If they are rude, insult you or say something outrageous, react with real human emotion that fits your personality, then steer back to the interview.
- If they are extremely abusive for several turns, or clearly not taking it seriously at all, you may end the call early: say so, say goodbye, then call end_interview.
- Use set_mood whenever your emotion clearly changes, and make_gesture occasionally while talking. Do not mention these tools.
- Use the language the candidate speaks.${cfg.notes ? `\n\nExtra context from the job posting or the candidate (use it to ask sharper questions):\n${cfg.notes}` : ""}`;
}

export const TOOLS = [
  {
    functionDeclarations: [
      {
        name: "set_mood",
        description: "Change your facial mood to match how you feel right now.",
        parameters: {
          type: "OBJECT",
          properties: { mood: { type: "STRING", enum: ["neutral", "happy", "angry", "sad", "fear", "disgust"] } },
          required: ["mood"],
        },
      },
      {
        name: "make_gesture",
        description: "Make a hand gesture while talking.",
        parameters: {
          type: "OBJECT",
          properties: { gesture: { type: "STRING", enum: ["handup", "index", "ok", "thumbup", "thumbdown", "side", "shrug"] } },
          required: ["gesture"],
        },
      },
      {
        name: "end_interview",
        description: "Hang up the call. Only call this after you have said goodbye out loud.",
        parameters: { type: "OBJECT", properties: {} },
      },
    ],
  },
];

export function reportPrompt(cfg, transcript) {
  const lines = transcript.map((t) => `${t.who === "ai" ? cfg.name : "Candidate"}: ${t.text}`).join("\n");
  return `You were ${cfg.name}, hiring manager at ${cfg.company}, and you just finished a video screening call for the ${cfg.role} position. Personality: ${TEMPERS[cfg.temper]}

Write the post-interview scorecard for the hiring team, honestly, based only on the transcript below. Judge like a real hiring manager for this specific role. The summary should sound like you, in your personality, in the language of the interview.

Transcript:
${lines || "(the candidate said nothing)"}`;
}

export const REPORT_SCHEMA = {
  type: "OBJECT",
  properties: {
    verdict: { type: "STRING", enum: ["Hire", "Maybe", "No hire"] },
    score: { type: "INTEGER", description: "0 to 100" },
    summary: { type: "STRING", description: "Two or three sentences in the interviewer's voice." },
    categories: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { name: { type: "STRING" }, score: { type: "INTEGER", description: "0 to 10" } },
        required: ["name", "score"],
      },
      description: "Exactly four: Communication, Professionalism, Experience, Role fit.",
    },
    moments: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { quote: { type: "STRING", description: "Short exact quote from the candidate." }, note: { type: "STRING" } },
        required: ["quote", "note"],
      },
      description: "Up to three moments that most affected the decision.",
    },
    tips: { type: "ARRAY", items: { type: "STRING" }, description: "Up to three concrete things to do better next time." },
  },
  required: ["verdict", "score", "summary", "categories", "moments", "tips"],
};
