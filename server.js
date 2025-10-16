require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qdrantService = require('./qdrant-service');

const app = express();
const PORT = process.env.PORT || 3000;

// Constants from Pseudocode
const SAFETY_FLOOR = 0.30;
const MAX_DISTANCE_TO_GOLD = 0.3;
const MAX_DISTANCE_TO_REF1 = 0.2;
const MAX_DISTANCE_TO_REF2 = 0.1;

const logs = [];

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/docs', express.static('docs'));

// Reference Mappings
const REFERENCE_MAPPINGS = {
  intent: {
    ref1: { 'i want to': 'i need to', 'how do i': 'how can i' },
    ref2: { 'i want to': 'i would like to', 'how do i': 'show me how' }
  },
  action: {
    ref1: { 'create': 'add', 'modify': 'update', 'search': 'find', 'delete': 'remove' },
    ref2: { 'create': 'generate', 'modify': 'change', 'search': 'locate', 'delete': 'erase' }
  },
  process: {
    ref1: { 'objective': 'goal', 'key result': 'KPI', 'initiative': 'action item', 'review meeting': 'meeting', 'key result checkin': 'checkin' },
    ref2: { 'objective': 'target', 'key result': 'metric', 'initiative': 'task', 'review meeting': 'session', 'key result checkin': 'intent' }
  },
  filter_name: {
    ref1: { 'due': 'deadline', 'priority': 'importance', 'status': 'state', 'assigned': 'owner', 'quarter': 'q' },
    ref2: { 'due': 'timing', 'priority': 'ranking', 'status': 'progress', 'assigned': 'responsible', 'quarter': 'season' }
  },
  filter_operator: {
    ref1: { 'equal to': '=', 'greater than': '>', 'less than': '<' },
    ref2: { 'equal to': '=', 'greater than': '>', 'less than': '<' }
  },
  filter_value: {
    ref1: { 'today': 'tomorrow', 'high': 'medium', 'pending': 'completed', 'q1': 'quarter 1' },
    ref2: { 'today': 'yesterday', 'high': 'low', 'pending': 'finished', 'q1': 'quarter 2' }
  }
};

// Pre-calculated Gold→Ref1 Scores
const GOLD_TO_REF1_SCORES = {
  intent: { 'i want to': 0.7774, 'how do i': 0.9350 },
  action: { 'create': 0.3091, 'modify': 0.6299, 'search': 0.6734, 'delete': 0.7576 },
  process: { 'objective': 0.4860, 'key result': 0.2255, 'initiative': 0.3236, 'review meeting': 0.6623, 'key result checkin': 0.4353 },
  filter_name: { 'due': 0.4843, 'priority': 0.6234, 'status': 0.4275, 'assigned': 0.4233, 'quarter': 0.3942 },
  filter_operator: { 'equal to': 0.4684, 'greater than': 0.4281, 'less than': 0.3261 },
  filter_value: { 'today': 0.7743, 'high': 0.3951, 'pending': 0.5588, 'q1': 0.3209 }
};

// Pre-calculated Gold→Ref2 Scores
const GOLD_TO_REF2_SCORES = {
  intent: { 'i want to': 0.7732, 'how do i': 0.5516 },
  action: { 'create': 0.7006, 'modify': 0.7718, 'search': 0.6685, 'delete': 0.5458 },
  process: { 'objective': 0.4323, 'key result': 0.2717, 'initiative': 0.4775, 'review meeting': 0.2810, 'key result checkin': 0.1245 },
  filter_name: { 'due': 0.3741, 'priority': 0.4828, 'status': 0.6076, 'assigned': 0.3655, 'quarter': 0.3058 },
  filter_operator: { 'equal to': 0.4684, 'greater than': 0.4281, 'less than': 0.3261 },
  filter_value: { 'today': 0.8571, 'high': 0.7103, 'pending': 0.5231, 'q1': 0.3022 }
};

// Dictionaries
const INTENT_DICTIONARY = {
  'menu': { primary: ['i would like to', 'i want to', 'i need to', 'i wish to', 'i intend to'], synonyms: [] },
  'help': { primary: ['how do i', 'does the system support', 'is there capability to', 'where can i', "what's the best way to"], synonyms: [] }
};

const ACTION_DICTIONARY = {
  'create': { primary: ['create', 'add'], synonyms: ['enter', 'input', 'register', 'insert', 'submit', 'append', 'post', 'start'] },
  'modify': { primary: ['modify', 'update'], synonyms: ['edit', 'revise', 'alter', 'amend', 'adjust', 'correct', 'change', 'fix', 'refine'] },
  'search': { primary: ['search for', 'search'], synonyms: ['find', 'locate', 'view', 'browse', 'display', 'show', 'list', 'check', 'inspect', 'open', 'access', 'retrieve', 'get', 'load', 'query', 'fetch'] },
  'delete': { primary: ['delete record', 'delete'], synonyms: ['remove', 'discard', 'erase', 'purge', 'destroy', 'eliminate', 'clear', 'drop', 'cancel', 'void', 'revoke', 'obliterate'] }
};

const PROCESS_DICTIONARY = {
  'objective': { primary: ['objective'], synonyms: ['goal'] },
  'key result': { primary: ['key result'], synonyms: ['KPI'] },
  'initiative': { primary: ['initiative'], synonyms: ['action item'] },
  'review meeting': { primary: ['review meeting'], synonyms: ['meeting'] },
  'key result checkin': { primary: ['key result checkin'], synonyms: ['checkin'] }
};

const FILTER_NAME_DICTIONARY = {
  'due': { primary: ['due', 'deadline'], synonyms: ['due date'] },
  'priority': { primary: ['priority'], synonyms: ['importance'] },
  'status': { primary: ['status'], synonyms: ['state'] },
  'assigned': { primary: ['assigned', 'assigned to'], synonyms: ['owner'] },
  'quarter': { primary: ['quarter', 'q'], synonyms: [] }
};

const FILTER_OPERATOR_DICTIONARY = {
  'equal to': { primary: ['=', 'equals', 'is'], synonyms: ['equal to'] },
  'greater than': { primary: ['>', 'greater than'], synonyms: ['more than'] },
  'less than': { primary: ['<', 'less than'], synonyms: ['below'] }
};

const FILTER_VALUE_DICTIONARY = {
  'date': { primary: ['today', 'tomorrow', 'yesterday'], synonyms: [] },
  'priority': { primary: ['high', 'low', 'medium'], synonyms: [] },
  'status': { primary: ['pending', 'completed'], synonyms: ['done'] },
  'quarter': { primary: ['q1', 'q2', 'q3', 'q4', 'quarter 1', 'quarter 2', 'quarter 3', 'quarter 4'], synonyms: [] }
};

const INTENT_PHRASE_TO_CATEGORY = {
  'i want to': 'menu', 'i need to': 'menu', 'i would like to': 'menu', 'i wish to': 'menu', 'i intend to': 'menu',
  'how do i': 'help', 'how can i': 'help', 'show me how': 'help', 'can you guide me': 'help', 'what is the way to': 'help'
};

const PROCESS_REFERENCE_MAPPING = {
  'objective': '/docs/objective-help.html',
  'key result': '/docs/key-result-help.html',
  'initiative': '/docs/initiative-help.html',
  'review meeting': '/docs/review-meeting-help.html',
  'key result checkin': '/docs/key-result-checkin-help.html'
};

const INTENT_PHRASE_DICTIONARY = {
  'menu': ["i'm looking to", "i'm trying to", 'i am preparing to', 'i am planning to', 'i am aiming to', 'i am hoping to', 'i feel ready to'],
  'help': ['how to', 'does it have', 'show me how to', "what's the way to", 'what steps do i take to', 'how may i', 'how can i']
};

const ACTION_PHRASE_DICTIONARY = {
  'create': ['add a record', 'enter a new record', 'input new data', 'make a new record', 'make an entry', 'open a new record'],
  'modify': ['edit a record', 'update a record', 'change details', 'revise record', 'alter record', 'amend details'],
  'search': ['search records', 'look up data', 'find records', 'view records', 'open records', 'show records'],
  'delete': ['delete record', 'delete entry', 'remove record', 'remove entry', 'discard record', 'discard entry']
};

const PROCESS_PHRASE_DICTIONARY = {
  'objective': ['target to achieve', 'plan for', 'aim to complete'],
  'key result': ['performance metric', 'result to track', 'key performance indicator'],
  'initiative': ['project to start', 'task to undertake', 'action to take'],
  'review meeting': ['team meeting', 'discussion session', 'review session'],
  'key result checkin': ['progress check', 'status update', 'check-in meeting']
};

const FILTER_NAME_PHRASE_DICTIONARY = {
  'due': ['when it is due', 'due by', 'completion date'],
  'priority': ['level of urgency', 'importance level', 'priority of'],
  'status': ['current state', 'progress status', 'condition of'],
  'assigned': ['who is responsible', 'assigned person', 'task owner']
};

const FILTER_OPERATOR_PHRASE_DICTIONARY = {
  'equal to': ['same as', 'matches', 'is exactly'],
  'greater than': ['exceeds', 'higher than', 'above'],
  'less than': ['under', 'lower than', 'lesser than']
};

const FILTER_VALUE_PHRASE_DICTIONARY = {
  'date': ['this week', 'next week', 'last week'],
  'priority': ['urgent', 'normal', 'minor'],
  'status': ['in progress', 'open', 'closed']
};

const FILTER_PATTERNS = [
  /(\w+)\s*(=|\bequals\b|\bis\b|\bequal to\b)\s*([^\s,]+)/gi,
  /(\w+)\s*(>|\bgreater than\b|\bmore than\b|\babove\b)\s*([^\s,]+)/gi,
  /(\w+)\s*(<|\bless than\b|\bbelow\b|\bunder\b)\s*([^\s,]+)/gi,
  /(due|priority|status|assigned)\s+(today|tomorrow|yesterday|high|low|medium|pending|completed|[^\s,]+)/gi,
  /where\s+(\w+)\s*(=|>|<|\bequals\b|\bis\b)\s*([^\s,]+)/gi,
  /(quarter|q)\s*(=|\bequals\b|\bis\b|\bequal to\b)\s*(q?[1-4])/gi,
  /for\s+(quarter|q)\s*(q?[1-4])/gi
];

// ========== HELPER FUNCTIONS ==========
function extractIntentText(userInput) {
  const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find'];
  for (const verb of actionVerbs) {
    const position = userInput.toLowerCase().indexOf(verb);
    if (position > 0) return userInput.substring(0, position).trim();
  }
  return userInput.split(' ').slice(0, 4).join(' ');
}

function extractProcessText(userInput) {
  const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find'];
  for (const verb of actionVerbs) {
    const position = userInput.toLowerCase().indexOf(verb);
    if (position >= 0) {
      let afterVerb = userInput.substring(position + verb.length).trim();
      const filterKeywords = ['with', 'where', 'having', 'for'];
      for (const keyword of filterKeywords) {
        const keywordPos = afterVerb.toLowerCase().indexOf(keyword);
        if (keywordPos >= 0) {
          afterVerb = afterVerb.substring(0, keywordPos).trim();
          break;
        }
      }
      return afterVerb;
    }
  }
  return '';
}

function extractActionText(userInput) {
  const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find', 'generate', 'change', 'locate', 'erase'];
  for (const verb of actionVerbs) {
    if (userInput.toLowerCase().includes(verb)) return verb;
  }
  return '';
}

// ========== SEQUENTIAL CIRCLE VALIDATION FUNCTION ==========
async function performCircleValidation(searchText, category) {
  const categoryMap = {
    'intent': 'intent', 'process': 'process', 'action': 'action',
    'filter_name': 'filter_name', 'filter_operator': 'filter_operator', 'filter_value': 'filter_value'
  };

  const qdrantCategory = categoryMap[category] || category;
  
  console.log(`\n[Qdrant] ==================== VALIDATION START ====================`);
  console.log(`[Qdrant] Search Text: "${searchText}"`);
  console.log(`[Qdrant] Category: ${qdrantCategory}`);

  try {
    console.log(`[Qdrant] Calling searchSimilar...`);
    const results = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);
    
    console.log(`[Qdrant] Raw Results:`, JSON.stringify(results, null, 2));

    if (!results || !results.match) {
      console.log(`[Qdrant] No match found`);
      console.log(`[Qdrant] ==================== VALIDATION END (NO MATCH) ====================\n`);
      return { matched: false, gold_standard: null, clarity: null, variables: null, validation_path: 'NONE' };
    }

    const gold_standard = results.match;
    const new_to_gold_score = results.score;
    
    console.log(`\n[Qdrant] Best Match Found:`);
    console.log(`   Gold Standard: "${gold_standard}"`);
    console.log(`   Similarity Score: ${new_to_gold_score.toFixed(4)}`);
    console.log(`   Distance to Gold: ${(1.0 - new_to_gold_score).toFixed(4)}`);

    // CHECK 1: Safety Floor
    console.log(`\n[Qdrant] CHECK 1: Safety Floor (${SAFETY_FLOOR})`);
    if (new_to_gold_score < SAFETY_FLOOR) {
      console.log(`   FAILED: Score ${new_to_gold_score.toFixed(4)} < ${SAFETY_FLOOR}`);
      console.log(`[Qdrant] ==================== VALIDATION END (SAFETY FLOOR) ====================\n`);
      return { matched: false, gold_standard, clarity: null, variables: null, validation_path: 'NONE' };
    }
    console.log(`   PASSED: Score ${new_to_gold_score.toFixed(4)} >= ${SAFETY_FLOOR}`);

    const variables = {
      variable1_new_value: searchText,
      variable2_distance_to_gold: 1.0 - new_to_gold_score,
      variable3_distance_to_ref1: 0,
      variable4_distance_to_ref2: 0
    };

    const ref1_phrase = REFERENCE_MAPPINGS[qdrantCategory]?.ref1[gold_standard];
    const ref2_phrase = REFERENCE_MAPPINGS[qdrantCategory]?.ref2[gold_standard];

    if (!ref1_phrase || !ref2_phrase) {
      console.log(`[Qdrant] Reference phrases not found for "${gold_standard}"`);
      console.log(`[Qdrant] ==================== VALIDATION END (NO REF) ====================\n`);
      return { matched: false, gold_standard, clarity: null, variables: null, validation_path: 'NONE' };
    }

    console.log(`\n[Qdrant] Reference Phrases:`);
    console.log(`   Ref1: "${ref1_phrase}"`);
    console.log(`   Ref2: "${ref2_phrase}"`);

    // CHECK 2: Distance to Gold Standard
    console.log(`\n[Qdrant] CHECK 2: Distance to Gold (< ${MAX_DISTANCE_TO_GOLD})`);
    console.log(`   Distance: ${variables.variable2_distance_to_gold.toFixed(4)}`);
    
    if (variables.variable2_distance_to_gold < MAX_DISTANCE_TO_GOLD) {
      console.log(`   PASSED: ${variables.variable2_distance_to_gold.toFixed(4)} < ${MAX_DISTANCE_TO_GOLD}`);
      console.log(`[Qdrant] VALIDATION SUCCESSFUL via GOLD path`);
      console.log(`[Qdrant] ==================== VALIDATION END (GOLD) ====================\n`);
      return {
        matched: true, gold_standard, clarity: 'Adequate Clarity',
        variables: { ...variables, variable3_distance_to_ref1: null, variable4_distance_to_ref2: null },
        validation_path: 'GOLD'
      };
    }
    console.log(`   FAILED: ${variables.variable2_distance_to_gold.toFixed(4)} >= ${MAX_DISTANCE_TO_GOLD}`);

    // CHECK 3: Distance to Reference 1
    console.log(`\n[Qdrant] CHECK 3: Distance to Ref1 (< ${MAX_DISTANCE_TO_REF1})`);
    const ref1_results = await qdrantService.searchSimilar(ref1_phrase, qdrantCategory, 10, 0.0);
    const new_to_ref1_score = ref1_results.score || 0;
    const gold_to_ref1_score = GOLD_TO_REF1_SCORES[qdrantCategory]?.[gold_standard] || 0;
    variables.variable3_distance_to_ref1 = Math.abs(new_to_ref1_score - gold_to_ref1_score);

    console.log(`   New → Ref1 Score: ${new_to_ref1_score.toFixed(4)}`);
    console.log(`   Gold → Ref1 Score: ${gold_to_ref1_score.toFixed(4)}`);
    console.log(`   Distance (diff): ${variables.variable3_distance_to_ref1.toFixed(4)}`);

    if (variables.variable3_distance_to_ref1 < MAX_DISTANCE_TO_REF1) {
      console.log(`   PASSED: ${variables.variable3_distance_to_ref1.toFixed(4)} < ${MAX_DISTANCE_TO_REF1}`);
      console.log(`[Qdrant] VALIDATION SUCCESSFUL via REF1 path`);
      console.log(`[Qdrant] ==================== VALIDATION END (REF1) ====================\n`);
      return {
        matched: true, gold_standard, clarity: 'Adequate Clarity',
        variables: { ...variables, variable4_distance_to_ref2: null },
        validation_path: 'REF1'
      };
    }
    console.log(`   FAILED: ${variables.variable3_distance_to_ref1.toFixed(4)} >= ${MAX_DISTANCE_TO_REF1}`);

    // CHECK 4: Distance to Reference 2
    console.log(`\n[Qdrant] CHECK 4: Distance to Ref2 (< ${MAX_DISTANCE_TO_REF2})`);
    const ref2_results = await qdrantService.searchSimilar(ref2_phrase, qdrantCategory, 10, 0.0);
    const new_to_ref2_score = ref2_results.score || 0;
    const gold_to_ref2_score = GOLD_TO_REF2_SCORES[qdrantCategory]?.[gold_standard] || 0;
    variables.variable4_distance_to_ref2 = Math.abs(new_to_ref2_score - gold_to_ref2_score);

    console.log(`   New → Ref2 Score: ${new_to_ref2_score.toFixed(4)}`);
    console.log(`   Gold → Ref2 Score: ${gold_to_ref2_score.toFixed(4)}`);
    console.log(`   Distance (diff): ${variables.variable4_distance_to_ref2.toFixed(4)}`);

    if (variables.variable4_distance_to_ref2 < MAX_DISTANCE_TO_REF2) {
      console.log(`   PASSED: ${variables.variable4_distance_to_ref2.toFixed(4)} < ${MAX_DISTANCE_TO_REF2}`);
      console.log(`[Qdrant] VALIDATION SUCCESSFUL via REF2 path`);
      console.log(`[Qdrant] ==================== VALIDATION END (REF2) ====================\n`);
      return {
        matched: true, gold_standard, clarity: 'Adequate Clarity',
        variables,
        validation_path: 'REF2'
      };
    }
    console.log(`   FAILED: ${variables.variable4_distance_to_ref2.toFixed(4)} >= ${MAX_DISTANCE_TO_REF2}`);

    console.log(`\n[Qdrant] All validation checks failed`);
    console.log(`[Qdrant] ==================== VALIDATION END (ALL FAILED) ====================\n`);
    return { matched: false, gold_standard, clarity: null, variables, validation_path: 'NONE' };

  } catch (error) {
    console.error(`[Qdrant] Validation error:`, error.message);
    console.error(`Stack:`, error.stack);
    console.log(`[Qdrant] ==================== VALIDATION END (ERROR) ====================\n`);
    return { matched: false, gold_standard: null, clarity: null, variables: null, validation_path: 'NONE' };
  }
}

// ========== CONVERSATION ANALYZER CLASS ==========
class ConversationAnalyzer {
  constructor() {
    this.reset();
  }

  reset() {
    this.analysis = {
      userInput: '',
      intent: { status: 'Not Found', value: '', reply: '' },
      process: { status: 'Not Found', value: '', reply: '' },
      action: { status: 'Not Found', value: '', reply: '' },
      filters: { status: 'Not Found', value: [], reply: '' },
      finalAnalysis: '',
      suggested_action: '',
      example_query: '',
      proceed_button: false,
      redirect_flag: false,
      redirect_url: null,
      step1_reply: '',
      step2_reply: '',
      step3_reply: '',
      step4_reply: '',
      validation_logs: []
    };
  }

  hasAnyKeywords(input) {
    const allKeywords = [
      ...Object.values(INTENT_DICTIONARY).flatMap(d => [...d.primary, ...d.synonyms]),
      ...Object.values(ACTION_DICTIONARY).flatMap(d => [...d.primary, ...d.synonyms]),
      ...Object.values(PROCESS_DICTIONARY).flatMap(d => [...d.primary, ...d.synonyms])
    ];
    return allKeywords.some(keyword => input.includes(keyword.toLowerCase()));
  }

  async step1_intentConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let intentFound = false;

    for (const [intent, patterns] of Object.entries(INTENT_DICTIONARY)) {
      for (const pattern of [...patterns.primary, ...patterns.synonyms]) {
        if (input.includes(pattern.toLowerCase())) {
          this.analysis.intent = { status: 'Clear', value: intent, reply: 'Your intent is clear.' };
          this.analysis.step1_reply = 'Your intent is clear.';
          intentFound = true;
          break;
        }
      }
      if (intentFound) break;
    }

    if (!intentFound) {
      for (const [intent, phrases] of Object.entries(INTENT_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.intent = { status: 'Adequate Clarity', value: intent, reply: 'Your intent seems somewhat clear.' };
            this.analysis.step1_reply = 'Your intent seems somewhat clear.';
            intentFound = true;
            break;
          }
        }
        if (intentFound) break;
      }
    }

    if (!intentFound) {
      const searchText = extractIntentText(input);
      const validation_result = await performCircleValidation(searchText, 'intent');

      if (validation_result.matched) {
        const detectedIntent = INTENT_PHRASE_TO_CATEGORY[validation_result.gold_standard] || 'menu';
        this.analysis.intent = { status: validation_result.clarity, value: detectedIntent, reply: 'Your intent seems somewhat clear.' };
        this.analysis.step1_reply = 'Your intent seems somewhat clear.';
        intentFound = true;
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: 'intent', ...validation_result.variables,
            validation_path: validation_result.validation_path, acceptance_status: 'ACCEPTED'
          });
        }
      } else if (validation_result.variables) {
        this.analysis.validation_logs.push({
          component_type: 'intent', ...validation_result.variables,
          validation_path: validation_result.validation_path, acceptance_status: 'REJECTED'
        });
      }
    }

    if (!intentFound) {
      if (this.hasAnyKeywords(input)) {
        this.analysis.intent = { status: 'Not Clear', value: '', reply: 'Unable to determine your intent.' };
        this.analysis.step1_reply = 'Unable to determine your intent.';
      } else {
        this.analysis.intent = { status: 'Not Found', value: '', reply: 'No intent detected.' };
        this.analysis.step1_reply = 'No intent detected.';
      }
    }
  }

  async step2_processConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let processFound = false;

    for (const [process, patterns] of Object.entries(PROCESS_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input === keyword.toLowerCase() || input.includes(keyword.toLowerCase())) {
          this.analysis.process = { status: 'Clear', value: process, reply: `Detected process: ${process}` };
          this.analysis.step2_reply = `Detected process: ${process}`;
          processFound = true;
          break;
        }
      }
      if (processFound) break;
    }

    if (!processFound) {
      for (const [process, phrases] of Object.entries(PROCESS_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.process = { status: 'Adequate Clarity', value: process, reply: `Detected process: ${process}` };
            this.analysis.step2_reply = `Detected process: ${process}`;
            processFound = true;
            break;
          }
        }
        if (processFound) break;
      }
    }

    if (!processFound) {
      const searchText = extractProcessText(input);
      if (searchText) {
        const validation_result = await performCircleValidation(searchText, 'process');
        if (validation_result.matched) {
          this.analysis.process = { status: validation_result.clarity, value: validation_result.gold_standard, reply: `Detected process: ${validation_result.gold_standard}` };
          this.analysis.step2_reply = `Detected process: ${validation_result.gold_standard}`;
          processFound = true;
          if (validation_result.variables) {
            this.analysis.validation_logs.push({ component_type: 'process', ...validation_result.variables, validation_path: validation_result.validation_path, acceptance_status: 'ACCEPTED' });
          }
        } else if (validation_result.variables) {
          this.analysis.validation_logs.push({ component_type: 'process', ...validation_result.variables, validation_path: validation_result.validation_path, acceptance_status: 'REJECTED' });
        }
      }
    }

    if (!processFound) {
      this.analysis.process = { status: 'Not Found', value: '', reply: 'No process detected.' };
      this.analysis.step2_reply = 'No process detected.';
    }
  }

  checkHelpRedirect() {
    const intentCategory = this.analysis.intent.value;
    const intentStatus = this.analysis.intent.status;