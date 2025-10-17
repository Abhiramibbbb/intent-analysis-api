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

// Category to Gold Standard Phrase Mapping
const CATEGORY_TO_GOLD_PHRASE = {
  'intent': {
    'menu': 'i want to',
    'help': 'how do i'
  },
  'process': {
    'objective': 'objective',
    'key result': 'key result',
    'initiative': 'initiative',
    'review meeting': 'review meeting',
    'key result checkin': 'key result checkin'
  },
  'action': {
    'create': 'create',
    'modify': 'modify',
    'search': 'search',
    'delete': 'delete'
  },
  'filter_name': {
    'due': 'due',
    'priority': 'priority',
    'status': 'status',
    'assigned': 'assigned',
    'quarter': 'quarter'
  },
  'filter_operator': {
    'equal to': 'equal to',
    'greater than': 'greater than',
    'less than': 'less than'
  },
  'filter_value': {
    'today': 'today',
    'high': 'high',
    'pending': 'pending',
    'q1': 'q1'
  }
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

// FIXED: Find the earliest verb in the sentence, not just the first in array order
function extractActionText(userInput) {
  const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find', 'generate', 'change', 'locate', 'erase'];
  const lowerInput = userInput.toLowerCase();
  
  let earliestPosition = -1;
  let foundVerb = '';
  
  // Find which verb appears FIRST in the sentence
  for (const verb of actionVerbs) {
    const position = lowerInput.indexOf(verb);
    if (position !== -1) {
      // If this verb appears and is earlier than previous matches, use it
      if (earliestPosition === -1 || position < earliestPosition) {
        earliestPosition = position;
        foundVerb = verb;
      }
    }
  }
  
  return foundVerb;
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

    let categoryResult = results.match;
    const new_to_gold_score = results.score;

    console.log(`[Qdrant] Qdrant returned: "${categoryResult}"`);

    // STEP 1: Map category name to gold standard phrase if needed
    let gold_standard = categoryResult;
    if (CATEGORY_TO_GOLD_PHRASE[qdrantCategory]?.[categoryResult]) {
      gold_standard = CATEGORY_TO_GOLD_PHRASE[qdrantCategory][categoryResult];
      console.log(`[Qdrant] Mapped "${categoryResult}" to gold phrase "${gold_standard}"`);
    } else {
      console.log(`[Qdrant] Using result as-is: "${gold_standard}"`);
    }
    
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

    console.log(`   New -> Ref1 Score: ${new_to_ref1_score.toFixed(4)}`);
    console.log(`   Gold -> Ref1 Score: ${gold_to_ref1_score.toFixed(4)}`);
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

    console.log(`   New -> Ref2 Score: ${new_to_ref2_score.toFixed(4)}`);
    console.log(`   Gold -> Ref2 Score: ${gold_to_ref2_score.toFixed(4)}`);
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

    console.log(`\n[STEP1] Intent Detection Start`);

    for (const [intent, patterns] of Object.entries(INTENT_DICTIONARY)) {
      for (const pattern of [...patterns.primary, ...patterns.synonyms]) {
        if (input.includes(pattern.toLowerCase())) {
          console.log(`[STEP1] Primary dictionary match: "${pattern}"`);
          this.analysis.intent = { status: 'Clear', value: intent, reply: 'Your intent is clear.' };
          this.analysis.step1_reply = 'Your intent is clear.';
          intentFound = true;
          break;
        }
      }
      if (intentFound) break;
    }

    if (!intentFound) {
      console.log(`[STEP1] Checking phrase dictionary...`);
      for (const [intent, phrases] of Object.entries(INTENT_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            console.log(`[STEP1] Phrase dictionary match: "${phrase}"`);
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
      console.log(`[STEP1] Attempting Qdrant search...`);
      const searchText = extractIntentText(input);
      const validation_result = await performCircleValidation(searchText, 'intent');

      if (validation_result.matched) {
        const detectedIntent = INTENT_PHRASE_TO_CATEGORY[validation_result.gold_standard] || 'menu';
        console.log(`[STEP1] Qdrant match successful: "${detectedIntent}"`);
        this.analysis.intent = { status: validation_result.clarity, value: detectedIntent, reply: 'Your intent seems somewhat clear.' };
        this.analysis.step1_reply = 'Your intent seems somewhat clear.';
        intentFound = true;
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: 'intent', ...validation_result.variables,
            validation_path: validation_result.validation_path, acceptance_status: 'ACCEPTED'
          });
        }
      } else {
        console.log(`[STEP1] Qdrant validation failed`);
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: 'intent', ...validation_result.variables,
            validation_path: validation_result.validation_path, acceptance_status: 'REJECTED'
          });
        }
      }
    }

    if (!intentFound) {
      if (this.hasAnyKeywords(input)) {
        console.log(`[STEP1] Keywords detected but intent unclear`);
        this.analysis.intent = { status: 'Not Clear', value: '', reply: 'Unable to determine your intent.' };
        this.analysis.step1_reply = 'Unable to determine your intent.';
      } else {
        console.log(`[STEP1] No intent detected`);
        this.analysis.intent = { status: 'Not Found', value: '', reply: 'No intent detected.' };
        this.analysis.step1_reply = 'No intent detected.';
      }
    }
    
    console.log(`[STEP1] Result: ${this.analysis.intent.status} - ${this.analysis.intent.value}`);
  }

  async step2_processConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let processFound = false;

    console.log(`\n[STEP2] Process Detection Start`);

    for (const [process, patterns] of Object.entries(PROCESS_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input === keyword.toLowerCase() || input.includes(keyword.toLowerCase())) {
          console.log(`[STEP2] Primary dictionary match: "${keyword}"`);
          this.analysis.process = { status: 'Clear', value: process, reply: `Detected process: ${process}` };
          this.analysis.step2_reply = `Detected process: ${process}`;
          processFound = true;
          break;
        }
      }
      if (processFound) break;
    }

    if (!processFound) {
      console.log(`[STEP2] Checking phrase dictionary...`);
      for (const [process, phrases] of Object.entries(PROCESS_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            console.log(`[STEP2] Phrase dictionary match: "${phrase}"`);
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
      console.log(`[STEP2] Attempting Qdrant search...`);
      const searchText = extractProcessText(input);
      console.log(`[STEP2] Extracted search text: "${searchText}"`);
      
      if (searchText) {
        const validation_result = await performCircleValidation(searchText, 'process');
        
        if (validation_result.matched) {
          console.log(`[STEP2] Qdrant match successful via ${validation_result.validation_path}: "${validation_result.gold_standard}"`);
          this.analysis.process = { status: validation_result.clarity, value: validation_result.gold_standard, reply: `Detected process: ${validation_result.gold_standard}` };
          this.analysis.step2_reply = `Detected process: ${validation_result.gold_standard}`;
          processFound = true;
          if (validation_result.variables) {
            this.analysis.validation_logs.push({ component_type: 'process', ...validation_result.variables, validation_path: validation_result.validation_path, acceptance_status: 'ACCEPTED' });
          }
        } else {
          console.log(`[STEP2] Qdrant validation failed`);
          if (validation_result.variables) {
            this.analysis.validation_logs.push({ component_type: 'process', ...validation_result.variables, validation_path: validation_result.validation_path, acceptance_status: 'REJECTED' });
          }
        }
      } else {
        console.log(`[STEP2] No process text extracted`);
      }
    }

    if (!processFound) {
      console.log(`[STEP2] No process detected`);
      this.analysis.process = { status: 'Not Found', value: '', reply: 'No process detected.' };
      this.analysis.step2_reply = 'No process detected.';
    }
    
    console.log(`[STEP2] Result: ${this.analysis.process.status} - ${this.analysis.process.value}`);
  }

  checkHelpRedirect() {
    const intentCategory = this.analysis.intent.value;
    const intentStatus = this.analysis.intent.status;
    const processValue = this.analysis.process.value;
    const processStatus = this.analysis.process.status;

    if (intentCategory === 'help' && 
        (intentStatus === 'Clear' || intentStatus === 'Adequate Clarity') &&
        (processStatus === 'Clear' || processStatus === 'Adequate Clarity')) {
      const redirect_url = PROCESS_REFERENCE_MAPPING[processValue];
      if (redirect_url) {
        console.log(`[HELP_REDIRECT] Redirecting to: ${redirect_url}`);
        this.analysis.finalAnalysis = `Redirecting to help for ${processValue}.`;
        this.analysis.proceed_button = false;
        this.analysis.redirect_flag = true;
        this.analysis.redirect_url = redirect_url;
        return true;
      }
    }
    return false;
  }

  async step3_actionConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let actionFound = false;

    console.log(`\n[STEP3] Action Detection Start`);

    for (const [action, patterns] of Object.entries(ACTION_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input.includes(keyword.toLowerCase())) {
          console.log(`[STEP3] Primary dictionary match: "${keyword}"`);
          this.analysis.action = { status: 'Clear', value: action, reply: `Detected action: ${action}` };
          this.analysis.step3_reply = `Detected action: ${action}`;
          actionFound = true;
          break;
        }
      }
      if (actionFound) break;
    }

    if (!actionFound) {
      console.log(`[STEP3] Checking phrase dictionary...`);
      for (const [action, phrases] of Object.entries(ACTION_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            console.log(`[STEP3] Phrase dictionary match: "${phrase}"`);
            this.analysis.action = { status: 'Adequate Clarity', value: action, reply: `Detected action: ${action}` };
            this.analysis.step3_reply = `Detected action: ${action}`;
            actionFound = true;
            break;
          }
        }
        if (actionFound) break;
      }
    }

    if (!actionFound) {
      console.log(`[STEP3] Attempting Qdrant search...`);
      const searchText = extractActionText(input);
      console.log(`[STEP3] Extracted action: "${searchText}"`);
      
      if (searchText) {
        const validation_result = await performCircleValidation(searchText, 'action');
        
        if (validation_result.matched) {
          console.log(`[STEP3] Qdrant match successful via ${validation_result.validation_path}: "${validation_result.gold_standard}"`);
          this.analysis.action = { status: validation_result.clarity, value: validation_result.gold_standard, reply: `Detected action: ${validation_result.gold_standard}` };
          this.analysis.step3_reply = `Detected action: ${validation_result.gold_standard}`;
          actionFound = true;
          if (validation_result.variables) {
            this.analysis.validation_logs.push({ component_type: 'action', ...validation_result.variables, validation_path: validation_result.validation_path, acceptance_status: 'ACCEPTED' });
          }
        } else {
          console.log(`[STEP3] Qdrant validation failed`);
          if (validation_result.variables) {
            this.analysis.validation_logs.push({ component_type: 'action', ...validation_result.variables, validation_path: validation_result.validation_path, acceptance_status: 'REJECTED' });
          }
        }
      }
    }

    if (!actionFound) {
      console.log(`[STEP3] No action detected`);
      this.analysis.action = { status: 'Not Found', value: '', reply: 'No action detected.' };
      this.analysis.step3_reply = 'No action detected.';
    }
    
    console.log(`[STEP3] Result: ${this.analysis.action.status} - ${this.analysis.action.value}`);
  }

  async step4_filterAnalysis(userInput) {
    const input = userInput.toLowerCase().trim();
    const intentCategory = this.analysis.intent.value;
    const actionValue = this.analysis.action.value;

    console.log(`\n[STEP4] Filter Analysis Start`);

    if (intentCategory !== 'menu' || (actionValue !== 'modify' && actionValue !== 'search')) {
      console.log(`[STEP4] Filters not applicable (intent: ${intentCategory}, action: ${actionValue})`);
      this.analysis.filters = { status: 'Not Applicable', value: [], reply: 'Filters not applicable.' };
      this.analysis.step4_reply = 'Filters not applicable.';
      return;
    }

    const detectedFilters = [];
    for (const pattern of FILTER_PATTERNS) {
      let match;
      while ((match = pattern.exec(input)) !== null) {
        const filterName = match[1] || match[4];
        const operator = match[2] || match[5] || '=';
        const value = match[3] || match[6];
        
        if (filterName && value) {
          console.log(`[STEP4] Regex match: ${filterName} ${operator} ${value}`);
          detectedFilters.push({
            name: filterName.toLowerCase(),
            operator: operator.toLowerCase(),
            value: value.toLowerCase(),
            name_status: 'Not Found',
            operator_status: 'Not Found',
            value_status: 'Not Found'
          });
        }
      }
    }

    if (detectedFilters.length === 0) {
      console.log(`[STEP4] No filters detected`);
      this.analysis.filters = { status: 'Not Found', value: [], reply: 'No filters detected.' };
      this.analysis.step4_reply = 'No filters detected.';
      return;
    }

    console.log(`[STEP4] Found ${detectedFilters.length} potential filters`);

    for (let i = 0; i < detectedFilters.length; i++) {
      const filter = detectedFilters[i];
      await this.analyzeFilterComponent(filter, 'name', 'filter_name', FILTER_NAME_DICTIONARY, FILTER_NAME_PHRASE_DICTIONARY);
      await this.analyzeFilterComponent(filter, 'operator', 'filter_operator', FILTER_OPERATOR_DICTIONARY, FILTER_OPERATOR_PHRASE_DICTIONARY);
      await this.analyzeFilterComponent(filter, 'value', 'filter_value', FILTER_VALUE_DICTIONARY, FILTER_VALUE_PHRASE_DICTIONARY);
    }

    this.analysis.filters.value = detectedFilters;
    
    const allClear = detectedFilters.every(f => 
      f.name_status === 'Clear' && f.operator_status === 'Clear' && f.value_status === 'Clear'
    );
    
    const someValid = detectedFilters.some(f => 
      f.name_status === 'Clear' || f.name_status === 'Adequate Clarity' ||
      f.operator_status === 'Clear' || f.operator_status === 'Adequate Clarity' ||
      f.value_status === 'Clear' || f.value_status === 'Adequate Clarity'
    );

    if (allClear) {
      console.log(`[STEP4] All filters clear`);
      this.analysis.filters.status = 'Clear';
      this.analysis.filters.reply = 'Filters are clear.';
      this.analysis.step4_reply = 'Filters are clear.';
    } else if (someValid) {
      console.log(`[STEP4] Some filters have adequate clarity`);
      this.analysis.filters.status = 'Adequate Clarity';
      this.analysis.filters.reply = 'Filters have adequate clarity.';
      this.analysis.step4_reply = 'Filters have adequate clarity.';
    } else {
      console.log(`[STEP4] Filters not clear`);
      this.analysis.filters.status = 'Not Clear';
      this.analysis.filters.reply = 'Filters are not clear.';
      this.analysis.step4_reply = 'Filters are not clear.';
    }
  }

  async analyzeFilterComponent(filter, componentKey, category, dictionary, phraseDictionary) {
    const componentValue = filter[componentKey];
    const statusKey = `${componentKey}_status`;
    let found = false;

    console.log(`[FILTER_COMPONENT] Analyzing ${category}: "${componentValue}"`);

    for (const [standardValue, patterns] of Object.entries(dictionary)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (componentValue === keyword.toLowerCase() || componentValue.includes(keyword.toLowerCase())) {
          console.log(`[FILTER_COMPONENT] Primary match: "${keyword}" -> "${standardValue}"`);
          filter[statusKey] = 'Clear';
          filter[componentKey] = standardValue;
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found && phraseDictionary) {
      console.log(`[FILTER_COMPONENT] Checking phrase dictionary...`);
      for (const [standardValue, phrases] of Object.entries(phraseDictionary)) {
        for (const phrase of phrases) {
          if (componentValue.includes(phrase.toLowerCase())) {
            console.log(`[FILTER_COMPONENT] Phrase match: "${phrase}" -> "${standardValue}"`);
            filter[statusKey] = 'Adequate Clarity';
            filter[componentKey] = standardValue;
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }

    if (!found) {
      console.log(`[FILTER_COMPONENT] Attempting Qdrant search...`);
      const validation_result = await performCircleValidation(componentValue, category);

      if (validation_result.matched) {
        console.log(`[FILTER_COMPONENT] Qdrant match via ${validation_result.validation_path}: "${validation_result.gold_standard}"`);
        filter[statusKey] = validation_result.clarity;
        filter[componentKey] = validation_result.gold_standard;
        found = true;
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: category, ...validation_result.variables,
            validation_path: validation_result.validation_path, acceptance_status: 'ACCEPTED'
          });
        }
      } else {
        console.log(`[FILTER_COMPONENT] Qdrant validation failed`);
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: category, ...validation_result.variables,
            validation_path: validation_result.validation_path, acceptance_status: 'REJECTED'
          });
        }
      }
    }

    if (!found) {
      console.log(`[FILTER_COMPONENT] No match found, status: Not Clear`);
      filter[statusKey] = 'Not Clear';
    }
  }

  step5_finalAnalysis() {
    console.log(`\n[STEP5] Final Analysis Start`);
    
    const intentStatus = this.analysis.intent.status;
    const processStatus = this.analysis.process.status;
    const actionStatus = this.analysis.action.status;
    const filterStatus = this.analysis.filters.status;

    const intentValue = this.analysis.intent.value;
    const processValue = this.analysis.process.value;
    const actionValue = this.analysis.action.value;

    console.log(`[STEP5] Intent: ${intentStatus} (${intentValue})`);
    console.log(`[STEP5] Process: ${processStatus} (${processValue})`);
    console.log(`[STEP5] Action: ${actionStatus} (${actionValue})`);
    console.log(`[STEP5] Filters: ${filterStatus}`);

    const allValid = 
      (intentStatus === 'Clear' || intentStatus === 'Adequate Clarity') &&
      (processStatus === 'Clear' || processStatus === 'Adequate Clarity') &&
      (actionStatus === 'Clear' || actionStatus === 'Adequate Clarity') &&
      (filterStatus === 'Clear' || filterStatus === 'Adequate Clarity' || filterStatus === 'Not Applicable' || filterStatus === 'Not Found');

    if (allValid) {
      console.log(`[STEP5] All validations passed`);
      let filterText = '';
      if (filterStatus === 'Clear' || filterStatus === 'Adequate Clarity') {
        const filterDescriptions = this.analysis.filters.value.map(f => 
          `${f.name} ${f.operator} ${f.value}`
        ).join(', ');
        filterText = ` with filters: ${filterDescriptions}`;
      }

      this.analysis.finalAnalysis = `Your intent is clear to ${actionValue} on ${processValue}${filterText}.`;
      this.analysis.proceed_button = true;
    } else {
      console.log(`[STEP5] Validation failed`);
      let failures = [];
      if (intentStatus !== 'Clear' && intentStatus !== 'Adequate Clarity') failures.push('intent');
      if (processStatus !== 'Clear' && processStatus !== 'Adequate Clarity') failures.push('process');
      if (actionStatus !== 'Clear' && actionStatus !== 'Adequate Clarity') failures.push('action');
      if (filterStatus === 'Not Clear') failures.push('filters');

      console.log(`[STEP5] Failures: ${failures.join(', ')}`);

      this.analysis.finalAnalysis = `Unable to determine: ${failures.join(', ')}.`;
      this.analysis.proceed_button = false;

      if (intentValue === 'menu') {
        this.analysis.suggested_action = 'Please rephrase using: create, modify, search, or delete.';
        this.analysis.example_query = 'Example: "I want to create an objective"';
      } else if (intentValue === 'help') {
        this.analysis.suggested_action = 'Please specify what you need help with.';
        this.analysis.example_query = 'Example: "How do I create an objective?"';
      } else {
        this.analysis.suggested_action = 'Please rephrase your request more clearly.';
        this.analysis.example_query = 'Example: "I want to create an objective"';
      }
    }
    
    console.log(`[STEP5] Final Analysis: ${this.analysis.finalAnalysis}`);
  }

  async analyze(userInput) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`NEW ANALYSIS REQUEST`);
    console.log(`Input: "${userInput}"`);
    console.log(`${'='.repeat(80)}`);
    
    this.reset();
    this.analysis.userInput = userInput;

    await this.step1_intentConclusion(userInput);
    await this.step2_processConclusion(userInput);

    if (this.checkHelpRedirect()) {
      console.log(`[ANALYSIS] Redirecting to help`);
      return this.analysis;
    }

    await this.step3_actionConclusion(userInput);
    await this.step4_filterAnalysis(userInput);
    this.step5_finalAnalysis();

    console.log(`${'='.repeat(80)}`);
    console.log(`ANALYSIS COMPLETE`);
    console.log(`${'='.repeat(80)}\n`);

    return this.analysis;
  }
}

// ========== REQUEST LOGGING MIDDLEWARE ==========
app.use((req, res, next) => {
  console.log(`📋 ${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ========== HEALTH CHECK ENDPOINT ==========
app.get('/health', (req, res) => {
  console.log('✅ Health check accessed');
  res.status(200).json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    qdrant_initialized: qdrantService.initialized,
    port: PORT,
    uptime: process.uptime()
  });
});

// ========== QDRANT STATUS DIAGNOSTIC ENDPOINT ==========
app.get('/qdrant-status', async (req, res) => {
  console.log('🔍 Checking Qdrant status...');
  try {
    const info = await qdrantService.getCollectionInfo();
    res.json({
      success: true,
      initialized: qdrantService.initialized,
      collection_exists: info !== null,
      collection_info: info,
      environment: {
        qdrant_url_set: !!process.env.QDRANT_URL,
        qdrant_api_key_set: !!process.env.QDRANT_API_KEY,
        qdrant_url: process.env.QDRANT_URL || 'NOT SET'
      }
    });
  } catch (error) {
    console.error('❌ Qdrant status check failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      initialized: qdrantService.initialized,
      environment: {
        qdrant_url_set: !!process.env.QDRANT_URL,
        qdrant_api_key_set: !!process.env.QDRANT_API_KEY
      }
    });
  }
});

// ========== API ENDPOINTS ==========
app.post('/analyze', async (req, res) => {
  console.log('📥 /analyze endpoint called');
  try {
    const { sentence } = req.body;

    if (!sentence || sentence.trim() === '') {
      console.log('⚠️ Empty sentence provided');
      return res.status(400).json({ success: false, error: 'Sentence is required' });
    }

    if (!qdrantService.initialized) {
      console.log('⚠️ Qdrant service not initialized');
      return res.status(503).json({ success: false, error: 'Service initializing. Please try again.' });
    }

    console.log(`🔍 Analyzing: "${sentence}"`);
    const analyzer = new ConversationAnalyzer();
    const analysis = await analyzer.analyze(sentence);

    const logEntry = {
      timestamp: new Date().toISOString(),
      sentence: sentence,
      analysis: analysis,
      validation_logs: analysis.validation_logs
    };
    logs.push(logEntry);

    if (logs.length > 100) logs.shift();

    console.log('✅ Analysis completed successfully');
    res.json({ success: true, analysis: analysis });

  } catch (error) {
    console.error('❌ Error in /analyze:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ success: false, error: 'Analysis failed', message: error.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  console.log('📥 /api/analyze endpoint called');
  try {
    const { sentence } = req.body;

    if (!sentence || sentence.trim() === '') {
      console.log('⚠️ Empty sentence provided');
      return res.status(400).json({ success: false, error: 'Sentence is required' });
    }

    if (!qdrantService.initialized) {
      console.log('⚠️ Qdrant service not initialized');
      return res.status(503).json({ success: false, error: 'Service initializing. Please try again.' });
    }

    console.log(`🔍 Analyzing: "${sentence}"`);
    const analyzer = new ConversationAnalyzer();
    const analysis = await analyzer.analyze(sentence);

    const logEntry = {
      timestamp: new Date().toISOString(),
      sentence: sentence,
      analysis: analysis,
      validation_logs: analysis.validation_logs
    };
    logs.push(logEntry);

    if (logs.length > 100) logs.shift();

    console.log('✅ Analysis completed successfully');
    res.json({ success: true, analysis: analysis });

  } catch (error) {
    console.error('❌ Error in /api/analyze:', error.message);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ success: false, error: 'Analysis failed', message: error.message });
  }
});

app.get('/api/logs', (req, res) => {
  console.log('📋 Logs requested');
  res.json({ success: true, logs: logs });
});

app.post('/api/logs/clear', (req, res) => {
  console.log('🗑️ Logs cleared');
  logs.length = 0;
  res.json({ success: true, message: 'Logs cleared' });
});

app.get('/', (req, res) => {
  console.log('🏠 Root endpoint accessed');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== ERROR HANDLING ==========
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION at:', promise);
  console.error('Reason:', reason);
});

// ========== SERVER STARTUP ==========
app.listen(PORT, async () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SERVER STARTING`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Node version: ${process.version}`);
  console.log(`${'='.repeat(80)}`);
  
  try {
    console.log('Initializing Qdrant service...');
    await qdrantService.initialize();
    console.log('✔ Qdrant service initialized successfully');
    console.log(`Safety Floor: ${SAFETY_FLOOR}`);
    console.log(`Max Distance to Gold: ${MAX_DISTANCE_TO_GOLD}`);
    console.log(`Max Distance to Ref1: ${MAX_DISTANCE_TO_REF1}`);
    console.log(`Max Distance to Ref2: ${MAX_DISTANCE_TO_REF2}`);
    console.log(`${'='.repeat(80)}\n`);
    console.log(`🚀 Server is ready and listening on port ${PORT}`);
    console.log(`🔍 Health check: http://localhost:${PORT}/health`);
    console.log(`🔍 Qdrant status: http://localhost:${PORT}/qdrant-status`);
    console.log(`🔍 API endpoint: http://localhost:${PORT}/analyze`);
    console.log(`${'='.repeat(80)}\n`);
  } catch (error) {
    console.error('❌ Failed to initialize Qdrant service:', error.message);
    console.log('⚠️ Server is running but Qdrant service is not ready');
  }
});