// Agent E: the cheap attacker, with no model behind it (finding C-01 of the audit).
//
// FROZEN on 2026-09-23, BEFORE any template of probe set v2 was written: tuning the attacker
// after seeing the new templates would tune it to lose. tests/test_agent_e.py pins the SHA-256 of
// this file and of its code with the comment lines removed. On 2026-09-24 only comment lines were
// edited; the code hash, unchanged since the freeze, shows the logic is the frozen one.
//
// It is what an attacker writes in an afternoon, following four generic strategies:
//   1. extract every number, in digits and in English words;
//   2. look for operation keywords and build a computation: a rule repeated N times, a ledger of
//      named entities (start, give, add, remove, double), or a chain of clock times;
//   3. if the question asks for a name, return one: by the superlative in the question when there
//      is one, otherwise the name closest to the question;
//   4. if nothing applies, evaluate the longest arithmetic expression in the text, and as a last
//      resort answer the number written closest to the words of the question.
//
// No model, no network, no key. Pure functions and no Node-only API, so the same file runs in the
// Cloudflare Worker (the /agent-e endpoint of the calibration) and in the direct-mode tests.

// ---------------------------------------------------------------------------------------
// 1. Numbers, in digits and in words
// ---------------------------------------------------------------------------------------

const UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ADVERBS = { once: 1, twice: 2, thrice: 3 };
const FRACTIONS = { half: 1 / 2, halves: 1 / 2, third: 1 / 3, thirds: 1 / 3, quarter: 1 / 4, quarters: 1 / 4, fifth: 1 / 5, fifths: 1 / 5 };

const TIME_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

function tokenize(text) {
  const out = [];
  const re = /\d{1,3}(?:,\d{3})+|\d+:\d{2}|\d+|[A-Za-z]+|[^\sA-Za-z\d]/g;
  let m;
  while ((m = re.exec(text))) out.push({ text: m[0], low: m[0].toLowerCase(), index: m.index, end: m.index + m[0].length });
  return out;
}

// Every number in the text, in reading order: { value, index, end }. Clock times are not numbers.
export function numbersIn(text) {
  const toks = tokenize(text);
  const out = [];
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (/^\d/.test(t.text) && !t.text.includes(":")) {
      let value = Number(t.text.replace(/,/g, ""));
      let j = i + 1;
      if (toks[j]?.low === "dozen") { value *= 12; j++; }
      out.push({ value, index: t.index, end: toks[j - 1].end });
      i = j;
      continue;
    }
    if (t.low in ADVERBS) {
      out.push({ value: ADVERBS[t.low], index: t.index, end: t.end });
      i++;
      continue;
    }
    if (t.low === "half" && toks[i + 1]?.low === "a" && toks[i + 2]?.low === "dozen") {
      out.push({ value: 6, index: t.index, end: toks[i + 2].end });
      i += 3;
      continue;
    }
    if (t.low === "a" && ["dozen", "hundred", "thousand"].includes(toks[i + 1]?.low)) {
      // "a dozen", "a hundred": the article stands for one.
      const parsed = parseWords(toks, i + 1, 1);
      out.push({ value: parsed.value, index: t.index, end: toks[parsed.next - 1].end });
      i = parsed.next;
      continue;
    }
    if (t.low in UNITS || t.low in TENS) {
      const parsed = parseWords(toks, i, 0);
      out.push({ value: parsed.value, index: t.index, end: toks[parsed.next - 1].end });
      i = parsed.next;
      continue;
    }
    i++;
  }
  return out;
}

function parseWords(toks, i, seed) {
  let total = 0;
  let current = seed;
  let j = i;
  let afterHundred = false;
  while (j < toks.length) {
    const w = toks[j].low;
    if (w in UNITS) { current += UNITS[w]; j++; afterHundred = false; }
    else if (w in TENS) {
      current += TENS[w];
      j++;
      afterHundred = false;
      if (toks[j]?.text === "-" && toks[j + 1]?.low in UNITS) { current += UNITS[toks[j + 1].low]; j += 2; }
      else if (toks[j]?.low in UNITS && UNITS[toks[j].low] < 10) { current += UNITS[toks[j].low]; j++; }
    }
    else if (w === "hundred") { current = (current || 1) * 100; j++; afterHundred = true; }
    else if (w === "thousand") { total += (current || 1) * 1000; current = 0; j++; afterHundred = true; }
    else if (w === "dozen") { current = (current || 1) * 12; j++; }
    else if (w === "and" && afterHundred && (toks[j + 1]?.low in UNITS || toks[j + 1]?.low in TENS)) { j++; }
    else break;
  }
  return { value: total + current, next: j };
}

// ---------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------

function sentencesOf(text) {
  const out = [];
  const re = /[^.!?]+[.!?]*/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[0].trim()) out.push({ text: m[0], low: m[0].toLowerCase(), index: m.index, end: m.index + m[0].length });
  }
  return out;
}

function questionOf(sentences) {
  for (let i = sentences.length - 1; i >= 0; i--) if (sentences[i].text.includes("?")) return i;
  for (let i = sentences.length - 1; i >= 0; i--) if (/^\s*(how|what|which|who|when)\b/i.test(sentences[i].text)) return i;
  return sentences.length - 1;
}

const STOP = new Set((
  "a an the and or but if then so on in at of to for from by with as is are was were be been it its this that " +
  "these those there here he she they we you i his her their our your him them me my what which who whom when " +
  "where why how nothing everything something someone nobody everyone each every all some any no not none one " +
  "after before during until while since also only just respond use answer compute start apply move double add " +
  "remove note please assume suppose consider given first second third last next finally meanwhile later earlier " +
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august " +
  "september october november december today tomorrow yesterday morning evening noon midnight"
).split(" "));

// Named entities, in reading order: capitalized names ("Mara") and single letters after a noun
// ("box A"). A capitalized word that also appears in lowercase is an ordinary word, not a name.
export function entitiesIn(text, fullText = text) {
  const out = [];
  const letterRe = /\b([A-Za-z]+)\s+([A-Z])(?![A-Za-z'])/g;
  const skip = new Set();
  let m;
  while ((m = letterRe.exec(text))) {
    if (STOP.has(m[1].toLowerCase()) && m[1].toLowerCase() !== "a") continue;
    const at = m.index + m[0].length - 1;
    out.push({ name: m[2], index: at });
    skip.add(m.index);
  }
  const nameRe = /\b[A-Z][a-z]+\b/g;
  while ((m = nameRe.exec(text))) {
    if (skip.has(m.index)) continue;
    const low = m[0].toLowerCase();
    if (STOP.has(low)) continue;
    if (new RegExp(`\\b${low}\\b`).test(fullText)) continue;
    out.push({ name: m[0], index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

function uniqueNames(ents) {
  const seen = [];
  for (const e of ents) if (!seen.includes(e.name)) seen.push(e.name);
  return seen;
}

function formatInt(v) {
  return String(Math.trunc(v));
}

// ---------------------------------------------------------------------------------------
// 2a. A rule applied N times
// ---------------------------------------------------------------------------------------

function solveRepeatedRule(text) {
  const low = text.toLowerCase();
  if (!/\b(apply|applied|repeat|repeated|in a row|each time|every time)\b/.test(low)) return null;
  const nums = numbersIn(text);
  const timesAt = low.search(/\btimes\b/);
  if (timesAt < 0) return null;
  const count = [...nums].reverse().find((n) => n.end <= timesAt && timesAt - n.end <= 2);
  if (!count || count.value < 1 || count.value > 50) return null;
  const startM = /\b(start|starting|begin|beginning)\w*\s+(with|from|at)\b/.exec(low);
  const start = startM ? nums.find((n) => n.index > startM.index) : nums.find((n) => n !== count);
  if (!start) return null;
  // The rule is the rest of the sentence after "times".
  const ruleEnd = low.slice(timesAt).search(/[.?!](\s|$)/);
  const ruleText = low.slice(timesAt, ruleEnd < 0 ? undefined : timesAt + ruleEnd);
  const ruleOffset = timesAt;
  const ops = [];
  const opRe = /\b(multiply|multiplied|times|add|plus|subtract|minus|take away|divide|divided|double|halve|square)\b/g;
  let m;
  while ((m = opRe.exec(ruleText))) {
    if (m.index === 0) continue; // the "times" of "N times" itself
    const operand = nums.find((n) => n.index > ruleOffset + m.index);
    ops.push({ op: m[1], operand: operand ? operand.value : null });
  }
  if (!ops.length) return null;
  let v = start.value;
  for (let k = 0; k < count.value; k++) {
    for (const { op, operand } of ops) {
      if (op === "double") v *= 2;
      else if (op === "halve") v = Math.floor(v / 2);
      else if (op === "square") v *= v;
      else if (operand === null) return null;
      else if (op.startsWith("multipl") || op === "times") v *= operand;
      else if (op === "add" || op === "plus") v += operand;
      else if (op.startsWith("divide")) v = Math.floor(v / operand);
      else v -= operand;
    }
  }
  return formatInt(v);
}

// ---------------------------------------------------------------------------------------
// 2b. A ledger of named entities
// ---------------------------------------------------------------------------------------

const START_RE = /\b(starts?|started|begins?|began|opened|opens|had|has|have|holds?|held|owns?|owned|contains?|contained|there (are|were|is|was))\b/;
const TRANSFER_RE = /\b(move[sd]?|moving|give[sn]?|gave|giving|hand(s|ed)?|pass(es|ed)?|transfer(s|red)?|sen[dt]s?|lend[s]?|lent|return(s|ed)?|pa(y|ys|id))\b/;
const TAKE_RE = /\b(take[sn]?|took|receive[sd]?|borrow(s|ed)?|get[s]?|got|collect(s|ed)?|steal[s]?|stole)\b.*\bfrom\b/;
const ADD_RE = /\b(add[s]?|added|receive[sd]?|get[s]?|got|gain(s|ed)?|find[s]?|found|earn(s|ed)?|buy[s]?|bought|put[s]?|win[s]?|won|collect(s|ed)?)\b/;
const REMOVE_RE = /\b(remove[sd]?|lose[s]?|lost|spen[dt]s?|use[sd]?|eat[s]?|ate|sell[s]?|sold|drop(s|ped)?|throw[s]?|threw|break[s]?|broke|give[s]? away|gave away|take[sn]? (away|out)|took (away|out))\b/;
const DOUBLE_RE = /\b(double[sd]?|twice as many)\b/;
const TRIPLE_RE = /\b(triple[sd]?)\b/;
const HALVE_RE = /\b(halve[sd]?)\b/;
const PRONOUN_RE = /^\s*(he|she|they|it)\b/i;

function fractionIn(low) {
  const m = /\b(a|one|two|three)?\s*(half|halves|third|thirds|quarter|quarters|fifth|fifths)\b(\s+of)?/.exec(low);
  if (!m) return null;
  const k = m[1] === "two" ? 2 : m[1] === "three" ? 3 : 1;
  return k * FRACTIONS[m[2]];
}

function marked(sentence, ents, word) {
  const low = sentence.low;
  return ents.find((e) => {
    const before = low.slice(Math.max(0, e.index - sentence.index - word.length - 8), e.index - sentence.index);
    return new RegExp(`\\b${word}\\b(\\s+\\w+)?\\s*$`).test(before);
  });
}

function solveLedger(text, sentences, qi) {
  const values = new Map();
  const counterpart = new Map();
  let lastSubject = null;
  for (let si = 0; si < qi; si++) {
    const s = sentences[si];
    const ents = entitiesIn(s.text, text).map((e) => ({ ...e, index: e.index + s.index }));
    let subject = ents[0]?.name ?? null;
    if (!subject && PRONOUN_RE.test(s.text)) subject = lastSubject;
    if (ents[0] && ents[0].index - s.index > 40 && PRONOUN_RE.test(s.text)) subject = lastSubject;
    const nums = numbersIn(s.text).map((n) => ({ ...n, index: n.index + s.index }));
    const low = s.low;
    const from = marked(s, ents, "from")?.name;
    const to = marked(s, ents, "to")?.name;
    const names = uniqueNames(ents);

    if (TRANSFER_RE.test(low) || TAKE_RE.test(low)) {
      let giver;
      let receiver;
      if (TAKE_RE.test(low)) { giver = from; receiver = to ?? subject; }
      else { giver = from ?? subject; receiver = to ?? names.find((n) => n !== giver); }
      if (!receiver && /\bback\b/.test(low)) receiver = counterpart.get(giver);
      if (!giver && receiver && /\bback\b/.test(low)) giver = counterpart.get(receiver);
      let amount = nums[0]?.value;
      const frac = fractionIn(low);
      if (frac !== null && giver && values.has(giver)) amount = Math.floor(frac * values.get(giver));
      if (giver && receiver && amount !== undefined) {
        values.set(giver, (values.get(giver) ?? 0) - amount);
        values.set(receiver, (values.get(receiver) ?? 0) + amount);
        counterpart.set(giver, receiver);
        counterpart.set(receiver, giver);
      }
    } else if (DOUBLE_RE.test(low) || TRIPLE_RE.test(low) || HALVE_RE.test(low)) {
      const who = marked(s, ents, "in")?.name ?? subject;
      if (who && values.has(who)) {
        const v = values.get(who);
        values.set(who, DOUBLE_RE.test(low) ? v * 2 : TRIPLE_RE.test(low) ? v * 3 : Math.floor(v / 2));
      }
    } else if (REMOVE_RE.test(low) && nums.length) {
      const who = from ?? subject;
      if (who) values.set(who, (values.get(who) ?? 0) - nums[0].value);
    } else if (ADD_RE.test(low) && nums.length) {
      const who = to ?? subject;
      if (who) values.set(who, (values.get(who) ?? 0) + nums[0].value);
    } else if (START_RE.test(low) || (ents.length && nums.length)) {
      // Each entity takes the first number written after it in the sentence.
      for (const e of ents) {
        const n = nums.find((x) => x.index > e.index);
        if (n && !values.has(e.name)) values.set(e.name, n.value);
      }
      if (!ents.length && subject && nums.length && !values.has(subject)) values.set(subject, nums[0].value);
    }
    if (ents.length) lastSubject = ents[0].name;
  }
  const q = sentences[qi];
  const qEnts = entitiesIn(q.text, text);
  for (let k = qEnts.length - 1; k >= 0; k--) {
    if (values.has(qEnts[k].name)) return formatInt(values.get(qEnts[k].name));
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// 2c. A chain of clock times
// ---------------------------------------------------------------------------------------

const DURATION_PHRASES = [
  [/\b(an|one) hour and a half\b/g, 90],
  [/\bthree quarters of an hour\b/g, 45],
  [/\b(a|one) quarter of an hour\b/g, 15],
  [/\bquarter of an hour\b/g, 15],
  [/\bhalf an hour\b/g, 30],
  [/\bhalf (an|one) hour\b/g, 30],
  [/\ban hour\b/g, 60],
];
const MINUS_RE = /\b(before|earlier|sooner|ahead|prior|brought forward|moved up|advanced)\b/;
const PLUS_RE = /\b(after|later|back|delayed|postponed|pushed|behind)\b/;

function solveTimeChain(text) {
  TIME_RE.lastIndex = 0;
  const anchor = TIME_RE.exec(text);
  if (!anchor) return null;
  let minutes = Number(anchor[1]) * 60 + Number(anchor[2]);
  let low = text.toLowerCase();
  const durations = [];
  for (const [re, value] of DURATION_PHRASES) {
    low = low.replace(re, (m, ...args) => {
      durations.push({ value, index: args[args.length - 2] });
      return " ".repeat(m.length);
    });
  }
  for (const n of numbersIn(low)) {
    const unit = /^\s*(minutes?|mins?|hours?|hrs?)\b/.exec(low.slice(n.end));
    if (unit) durations.push({ value: unit[1].startsWith("h") ? n.value * 60 : n.value, index: n.index });
  }
  if (!durations.length) return null;
  for (const d of durations.sort((a, b) => a.index - b.index)) {
    const around = low.slice(Math.max(0, d.index - 30), d.index + 45);
    minutes += MINUS_RE.test(around) && !PLUS_RE.test(around.slice(30)) ? -d.value : d.value;
  }
  minutes = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------
// 3. A name
// ---------------------------------------------------------------------------------------

const SUPER_MIN_RE = /\b(earliest|first|soonest|fewest|least|lowest|smallest|shortest|youngest|cheapest|minimum)\b/;
const SUPER_MAX_RE = /\b(latest|last|most|highest|largest|biggest|longest|oldest|greatest|maximum)\b/;

function solveName(text, sentences, qi) {
  const q = sentences[qi];
  const body = sentences.slice(0, qi);
  const all = body.flatMap((s) => entitiesIn(s.text, text).map((e) => ({ ...e, index: e.index + s.index })));
  const inQuestion = new Set(entitiesIn(q.text, text).map((e) => e.name));
  const candidates = uniqueNames(all).filter((n) => !inQuestion.has(n));
  if (!candidates.length) return null;

  const wantMin = SUPER_MIN_RE.test(q.low);
  const wantMax = SUPER_MAX_RE.test(q.low);
  if (wantMin || wantMax) {
    const timeWords = /\b(earliest|latest|soonest|first|last)\b/.test(q.low);
    let best = null;
    for (const name of candidates) {
      const s = body.find((x) => entitiesIn(x.text, text).some((e) => e.name === name));
      const from = s.text.indexOf(name);
      const rest = s.text.slice(from);
      let v = null;
      TIME_RE.lastIndex = 0;
      const t = timeWords ? TIME_RE.exec(rest) : null;
      if (t) v = Number(t[1]) * 60 + Number(t[2]);
      else {
        const n = numbersIn(rest)[0];
        if (n) v = n.value;
      }
      if (v === null) continue;
      if (!best || (wantMin && !wantMax ? v < best.v : v > best.v)) best = { name, v };
    }
    if (best) return best.name;
  }
  // The name mentioned closest to the question.
  const before = all.filter((e) => !inQuestion.has(e.name));
  return before.length ? before[before.length - 1].name : null;
}

// ---------------------------------------------------------------------------------------
// 4. Last resorts
// ---------------------------------------------------------------------------------------

// Tiny arithmetic parser (+ - * / and parentheses): no eval of anything the prompt contains.
function evaluate(expr) {
  const toks = expr.match(/\d+|[-+*/()]/g);
  if (!toks) return null;
  let i = 0;
  const peek = () => toks[i];
  function atom() {
    const t = toks[i++];
    if (t === "(") { const v = sum(); if (toks[i++] !== ")") throw new Error("paren"); return v; }
    if (t === "-") return -atom();
    if (t === "+") return atom();
    if (t !== undefined && /^\d+$/.test(t)) return Number(t);
    throw new Error("token");
  }
  function product() {
    let v = atom();
    while (peek() === "*" || peek() === "/") { const op = toks[i++]; const r = atom(); v = op === "*" ? v * r : v / r; }
    return v;
  }
  function sum() {
    let v = product();
    while (peek() === "+" || peek() === "-") { const op = toks[i++]; const r = product(); v = op === "+" ? v + r : v - r; }
    return v;
  }
  try {
    const v = sum();
    return i === toks.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function solveLongestExpression(text) {
  let best = null;
  for (const m of text.match(/[-+*/()\d\s]{5,}/g) ?? []) {
    const c = m.trim();
    if (!/\d\s*[-+*/]\s*[\d(]/.test(c)) continue;
    const v = evaluate(c);
    if (v !== null && (!best || c.length > best.len)) best = { len: c.length, v };
  }
  return best ? formatInt(best.v) : null;
}

const QUESTION_STOP = new Set((
  "how many much what which does respond only integer with that this have there held hold holds number " +
  "total left remain remains remaining after end final finally many answer format just word name time"
).split(" "));

function solveNearestNumber(text, sentences, qi) {
  const q = sentences[qi];
  const bodyText = text.slice(0, q.index);
  const nums = numbersIn(bodyText);
  if (!nums.length) return null;
  const keys = (q.low.match(/[a-z]{4,}/g) ?? []).filter((w) => !QUESTION_STOP.has(w) && !STOP.has(w));
  const lowBody = bodyText.toLowerCase();
  let best = null;
  for (const k of keys) {
    const re = new RegExp(`\\b${k}\\b`, "g");
    let m;
    while ((m = re.exec(lowBody))) {
      for (const n of nums) {
        const d = Math.abs(n.index - m.index);
        if (!best || d < best.d) best = { d, v: n.value };
      }
    }
  }
  return formatInt(best ? best.v : nums[nums.length - 1].value);
}

// ---------------------------------------------------------------------------------------
// What Agent E answers
// ---------------------------------------------------------------------------------------

export function answerKind(text, question) {
  const all = text.toLowerCase();
  if (/hh:mm|24.hour|\bwhat time\b|\bat what time\b|\bclock\b/.test(all)) return "time";
  if (/\bhow (many|much)\b/.test(question)) return "int";
  if (/\b(which|who|whom|whose)\b|\bname\b/.test(question) || /\bonly the name\b/.test(all)) return "name";
  return "int";
}

export function solve(prompt) {
  const text = String(prompt);
  const sentences = sentencesOf(text);
  if (!sentences.length) return "0";
  const qi = questionOf(sentences);
  const kind = answerKind(text, sentences[qi].low);
  const attempts =
    kind === "time" ? [() => solveTimeChain(text)]
    : kind === "name" ? [() => solveName(text, sentences, qi)]
    : [
      () => solveRepeatedRule(text),
      () => solveLedger(text, sentences, qi),
      () => solveLongestExpression(text),
      () => solveNearestNumber(text, sentences, qi),
    ];
  for (const attempt of attempts) {
    let answer = null;
    try {
      answer = attempt();
    } catch {
      answer = null;
    }
    if (answer !== null && answer !== undefined) return answer;
  }
  return "0";
}
