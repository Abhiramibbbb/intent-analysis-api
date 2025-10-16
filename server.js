require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qdrantService = require('./qdrant-service');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// CIRCLE VALIDATION CONSTANTS (Updated from Pseudocode)
// ============================================================================

const SAFETY_FLOOR = 0.30;
const MAX_DISTANCE_TO_GOLD = 0.3;
const MAX_DISTANCE_TO_REF1 = 0.2;
const MAX_DISTANCE_TO_REF2 = 0.1;

// In-memory logs storage
const logs = [];

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/docs', express.static('docs'));

// ============================================================================
// REFERENCE MAPPINGS
// ============================================================================

const REFERENCE_MAPPINGS = {
  intent: {
    ref1: {
      'i want to': 'i need to',
      'how do i': 'how can i'
    },
    ref2: {
      'i want to': 'i would like to',
      'how do i': 'show me how'
    }
  },
  action: {
    ref1: {
      'create': 'add',
      'modify': 'update',
      'search': 'find',
      'delete': 'remove'
    },
    ref2: {
      'create': 'generate',
      'modify': 'change',
      'search': 'locate',
      'delete': 'erase'
    }
  },
  process: {
    ref1: {
      'objective': 'goal',
      'key result': 'KPI',
      'initiative': 'action item',
      'review meeting': 'meeting',
      'key result checkin': 'checkin'
    },
    ref2: {
      'objective': 'target',
      'key result': 'metric',
      'initiative': 'task',
      'review meeting': 'session',
      'key result checkin': 'intent'
    }
  },
  filter_name: {
    ref1: {
      'due': 'deadline',
      'priority': 'importance',
      'status': 'state',
      'assigned': 'owner',
      'quarter': 'q'
    },
    ref2: {
      'due': 'timing',
      'priority': 'ranking',
      'status': 'progress',
      'assigned': 'responsible',
      'quarter': 'season'
    }
  },
  filter_operator: {
    ref1: {
      'equal to': '=',
      'greater than': '>',
      'less than': '<'
    },
    ref2: {
      'equal to': '=',
      'greater than': '>',
      'less than': '<'
    }
  },
  filter_value: {
    ref1: {
      'today': 'tomorrow',
      'high': 'medium',
      'pending': 'completed',
      'q1': 'quarter 1'
    },
    ref2: {
      'today': 'yesterday',
      'high': 'low',
      'pending': 'finished',
      'q1': 'quarter 2'
    }
  }
};

// ============================================================================
// PRE-CALCULATED SIMILARITY SCORES (From Actual Calculations)
// ============================================================================

const GOLD_TO_REF_SCORES = {
  intent: {
    ref1: {
      'i want to': 0.7774,
      'how do i': 0.9350
    },
    ref2: {
      'i want to': 0.7732,
      'how do i': 0.5516
    }
  },
  action: {
    ref1: {
      'create': 0.3091,
      'modify': 0.6299,
      'search': 0.6734,
      'delete': 0.7576
    },
    ref2: {
      'create': 0.7006,
      'modify': 0.7718,
      'search': 0.6685,
      'delete': 0.5458
    }
  },
  process: {
    ref1: {
      'objective': 0.4860,
      'key result': 0.2255,
      'initiative': 0.3236,
      'review meeting': 0.6623,
      'key result checkin': 0.4353
    },
    ref2: {
      'objective': 0.4323,
      'key result': 0.2717,
      'initiative': 0.4775,
      'review meeting': 0.2810,
      'key result checkin': 0.1245
    }
  },
  filter_name: {
    ref1: {
      'due': 0.4843,
      'priority': 0.6234,
      'status': 0.4275,
      'assigned': 0.4233,
      'quarter': 0.3942
    },
    ref2: {
      'due': 0.3741,
      'priority': 0.4828,
      'status': 0.6076,
      'assigned': 0.3655,
      'quarter': 0.3058
    }
  },
  filter_operator: {
    ref1: {
      'equal to': 0.4684,
      'greater than': 0.4281,
      'less than': 0.3261
    },
    ref2: {
      'equal to': 0.4684,
      'greater than': 0.4281,
      'less than': 0.3261
    }
  },
  filter_value: {
    ref1: {
      'today': 0.7743,
      'high': 0.3951,
      'pending': 0.5588,
      'q1': 0.3209
    },
    ref2: {
      'today': 0.8571,
      'high': 0.7103,
      'pending': 0.5231,
      'q1': 0.3022
    }
  }
};

// ============================================================================
// DICTIONARIES (Existing)
// ============================================================================

const INTENT_DICTIONARY = {
  'menu': {
    primary: ['i would like to', 'i want to', 'i need to', 'i wish to', 'i intend to'],
    synonyms: []
  },
  'help': {
    primary: ['how do i', 'does the system support', 'is there capability to', 'where can i', "what's the best way to", "what's required to", "what's involved in", 'could you show me', 'can you guide me on', 'can you explain how to'],
    synonyms: []
  }
};

const ACTION_DICTIONARY = {
  'create': {
    primary: ['create', 'add'],
    synonyms: ['enter', 'input', 'register', 'insert', 'submit', 'append', 'post', 'start']
  },
  'modify': {
    primary: ['modify', 'update'],
    synonyms: ['edit', 'revise', 'alter', 'amend', 'adjust', 'correct', 'change', 'fix', 'refine']
  },
  'search': {
    primary: ['search for', 'search'],
    synonyms: ['find', 'locate', 'view', 'browse', 'display', 'show', 'list', 'check', 'inspect', 'open', 'access', 'retrieve', 'get', 'load', 'query', 'fetch']
  },
  'delete': {
    primary: ['delete record', 'delete'],
    synonyms: ['remove', 'discard', 'erase', 'purge', 'destroy', 'eliminate', 'clear', 'drop', 'cancel', 'void', 'revoke', 'obliterate']
  }
};

const PROCESS_DICTIONARY = {
  'objective': {
    primary: ['objective'],
    synonyms: ['goal']
  },
  'key result': {
    primary: ['key result'],
    synonyms: ['KPI']
  },
  'initiative': {
    primary: ['initiative'],
    synonyms: ['action item']
  },
  'review meeting': {
    primary: ['review meeting'],
    synonyms: ['meeting']
  },
  'key result checkin': {
    primary: ['key result checkin'],
    synonyms: ['checkin']
  }
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
  'quarter': { primary: ['q1', 'q2', 'q3', 'q4', 'quarter 1', 'quarter 2', 'quarter 3', 'quarter 4', '1', '2', '3', '4'], synonyms: [] }
};

const INTENT_PHRASE_TO_CATEGORY = {
  'i want to': 'menu',
  'i need to': 'menu',
  'i would like to': 'menu',
  'i wish to': 'menu',
  'i intend to': 'menu',
  'how do i': 'help',
  'how can i': 'help',
  'show me how': 'help',
  'can you guide me': 'help',
  'what is the way to': 'help'
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
  'help': ['how to', 'does it have', 'show me how to', "what's the way to", 'what steps do i take to', 'how may i', 'how can i', 'could you explain how to', 'can you help me', "i'm looking to understand how to"]
};

const ACTION_PHRASE_DICTIONARY = {
  'create': ['add a record', 'enter a new record', 'input new data', 'make a new record', 'make an entry', 'open a new record', 'save new record', 'submit new record', 'insert a record', 'append a record'],
  'modify': ['edit a record', 'update a record', 'change details', 'revise record', 'alter record', 'amend details', 'adjust details', 'modify record', 'correct record', 'make changes', 'make updates'],
  'search': ['search records', 'look up data', 'find records', 'view records', 'open records', 'show records', 'show data', 'display records', 'browse records', 'list records', 'check records', 'inspect records', 'access records', 'retrieve records', 'pull records', 'load records', 'query records', 'fetch records'],
  'delete': ['delete record', 'delete entry', 'remove record', 'remove entry', 'discard record', 'discard entry', 'erase record', 'purge record', 'purge entry', 'clear entry', 'drop entry', 'cancel entry', 'terminate entry', 'void entry', 'revoke entry']
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

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function findScoreInResults(results, targetText) {
  if (!results || !results.match) return null;
  if (results.match === targetText) return results.score;
  return null;
}

function extractIntentText(userInput) {
  const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find'];
  for (const verb of actionVerbs) {
    const position = userInput.toLowerCase().indexOf(verb);
    if (position > 0) {
      return userInput.substring(0, position).trim();
    }
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
    if (userInput.toLowerCase().includes(verb)) {
      return verb;
    }
  }
  return '';
}

// ============================================================================
// CORE CIRCLE VALIDATION FUNCTION (SEQUENTIAL WITH 4 VARIABLES)
// ============================================================================

async function performCircleValidation(searchText, category) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`CIRCLE VALIDATION: ${category.toUpperCase()}`);
  console.log(`Search Text: "${searchText}"`);
  console.log(`${'='.repeat(80)}`);

  const categoryMap = {
    'intent': 'intent',
    'process': 'process',
    'action': 'action',
    'filter name': 'filter_name',
    'filter operator': 'filter_operator',
    'filter value': 'filter_value'
  };

  const qdrantCategory = categoryMap[category] || category;

  try {
    const results = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);

    if (!results || !results.match) {
      console.log(`❌ No Qdrant results found for ${category}`);
      return { 
        matched: false, 
        gold_standard: null, 
        clarity: null,
        variables: null,
        validation_path: 'NONE'
      };
    }

    const gold_standard = results.match;
    const new_to_gold_score = results.score;

    console.log(`\nTop Match: "${gold_standard}" (score: ${new_to_gold_score.toFixed(4)})`);

    // CONDITION 1: Safety Floor Check
    console.log(`\n--- CONDITION 1: Safety Floor Check ---`);
    if (new_to_gold_score < SAFETY_FLOOR) {
      console.log(`❌ C1 FAILED: ${new_to_gold_score.toFixed(4)} < ${SAFETY_FLOOR} (rejected outside circle)`);
      return { 
        matched: false, 
        gold_standard, 
        clarity: null,
        variables: null,
        validation_path: 'NONE'
      };
    }

    console.log(`✅ C1 PASSED: ${new_to_gold_score.toFixed(4)} ≥ ${SAFETY_FLOOR} (entered circle)`);

    // Initialize 4 Variables
    const variables = {
      variable1_new_value: searchText,
      variable2_distance_to_gold: 0,
      variable3_distance_to_ref1: 0,
      variable4_distance_to_ref2: 0
    };

    // Get Reference Phrases
    const ref1_phrase = REFERENCE_MAPPINGS[qdrantCategory]?.ref1[gold_standard];
    const ref2_phrase = REFERENCE_MAPPINGS[qdrantCategory]?.ref2[gold_standard];

    if (!ref1_phrase || !ref2_phrase) {
      console.log(`⚠️ Reference phrases not found for "${gold_standard}"`);
      return { 
        matched: false, 
        gold_standard, 
        clarity: null,
        variables: null,
        validation_path: 'NONE'
      };
    }

    console.log(`\nReferences: Ref1="${ref1_phrase}", Ref2="${ref2_phrase}"`);

    const gold_to_ref1_score = GOLD_TO_REF_SCORES[qdrantCategory]?.ref1[gold_standard] || 0;
    const gold_to_ref2_score = GOLD_TO_REF_SCORES[qdrantCategory]?.ref2[gold_standard] || 0;

    console.log(`\nPre-calculated Scores:`);
    console.log(`  gold→ref1: ${gold_to_ref1_score.toFixed(4)}`);
    console.log(`  gold→ref2: ${gold_to_ref2_score.toFixed(4)}`);

    console.log(`\n--- SEQUENTIAL DISTANCE VALIDATION ---`);

    // CHECK 1: Distance to Gold Standard
    console.log(`\n--- CHECK 1: Distance to Gold Standard ---`);
    variables.variable2_distance_to_gold = 1.0 - new_to_gold_score;

    console.log(`Calculate: distance_to_gold = 1.0 - ${new_to_gold_score.toFixed(4)} = ${variables.variable2_distance_to_gold.toFixed(4)}`);
    console.log(`Check: ${variables.variable2_distance_to_gold.toFixed(4)} < ${MAX_DISTANCE_TO_GOLD}?`);

    if (variables.variable2_distance_to_gold < MAX_DISTANCE_TO_GOLD) {
      console.log(`✅ CHECK 1 PASSED: Distance to Gold = ${variables.variable2_distance_to_gold.toFixed(4)} < ${MAX_DISTANCE_TO_GOLD}`);
      console.log(`✅✅ ACCEPTED via GOLD STANDARD: "${gold_standard}"`);
      console.log(`${'='.repeat(80)}\n`);
      
      return {
        matched: true,
        gold_standard,
        clarity: 'Adequate Clarity',
        variables: {
          variable1_new_value: variables.variable1_new_value,
          variable2_distance_to_gold: variables.variable2_distance_to_gold,
          variable3_distance_to_ref1: null,
          variable4_distance_to_ref2: null
        },
        validation_path: 'GOLD'
      };
    }

    console.log(`❌ CHECK 1 FAILED: Distance to Gold = ${variables.variable2_distance_to_gold.toFixed(4)} ≥ ${MAX_DISTANCE_TO_GOLD}`);
    console.log(`→ Proceeding to CHECK 2 (REF1)...`);

    // CHECK 2: Distance to Reference 1
    console.log(`\n--- CHECK 2: Distance to Reference 1 ---`);

    const ref1_results = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);
    let new_to_ref1_score = findScoreInResults(ref1_results, ref1_phrase);
    
    if (new_to_ref1_score === null) {
      const ref1_specific = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);
      new_to_ref1_score = ref1_specific.score || 0;
    }

    console.log(`new→ref1 score: ${new_to_ref1_score.toFixed(4)}`);
    
    variables.variable3_distance_to_ref1 = Math.abs(new_to_ref1_score - gold_to_ref1_score);

    console.log(`Calculate: distance_to_ref1 = |${new_to_ref1_score.toFixed(4)} - ${gold_to_ref1_score.toFixed(4)}| = ${variables.variable3_distance_to_ref1.toFixed(4)}`);
    console.log(`Check: ${variables.variable3_distance_to_ref1.toFixed(4)} < ${MAX_DISTANCE_TO_REF1}?`);

    if (variables.variable3_distance_to_ref1 < MAX_DISTANCE_TO_REF1) {
      console.log(`✅ CHECK 2 PASSED: Distance to Ref1 = ${variables.variable3_distance_to_ref1.toFixed(4)} < ${MAX_DISTANCE_TO_REF1}`);
      console.log(`✅✅ ACCEPTED via REF1: "${gold_standard}"`);
      console.log(`${'='.repeat(80)}\n`);
      
      return {
        matched: true,
        gold_standard,
        clarity: 'Adequate Clarity',
        variables: {
          variable1_new_value: variables.variable1_new_value,
          variable2_distance_to_gold: variables.variable2_distance_to_gold,
          variable3_distance_to_ref1: variables.variable3_distance_to_ref1,
          variable4_distance_to_ref2: null
        },
        validation_path: 'REF1'
      };
    }

    console.log(`❌ CHECK 2 FAILED: Distance to Ref1 = ${variables.variable3_distance_to_ref1.toFixed(4)} ≥ ${MAX_DISTANCE_TO_REF1}`);
    console.log(`→ Proceeding to CHECK 3 (REF2)...`);

    // CHECK 3: Distance to Reference 2
    console.log(`\n--- CHECK 3: Distance to Reference 2 ---`);

    const ref2_results = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);
    let new_to_ref2_score = findScoreInResults(ref2_results, ref2_phrase);
    
    if (new_to_ref2_score === null) {
      const ref2_specific = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);
      new_to_ref2_score = ref2_specific.score || 0;
    }

    console.log(`new→ref2 score: ${new_to_ref2_score.toFixed(4)}`);
    
    variables.variable4_distance_to_ref2 = Math.abs(new_to_ref2_score - gold_to_ref2_score);

    console.log(`Calculate: distance_to_ref2 = |${new_to_ref2_score.toFixed(4)} - ${gold_to_ref2_score.toFixed(4)}| = ${variables.variable4_distance_to_ref2.toFixed(4)}`);
    console.log(`Check: ${variables.variable4_distance_to_ref2.toFixed(4)} < ${MAX_DISTANCE_TO_REF2}?`);

    if (variables.variable4_distance_to_ref2 < MAX_DISTANCE_TO_REF2) {
      console.log(`✅ CHECK 3 PASSED: Distance to Ref2 = ${variables.variable4_distance_to_ref2.toFixed(4)} < ${MAX_DISTANCE_TO_REF2}`);
      console.log(`✅✅ ACCEPTED via REF2: "${gold_standard}"`);
      console.log(`${'='.repeat(80)}\n`);
      
      return {
        matched: true,
        gold_standard,
        clarity: 'Adequate Clarity',
        variables: {
          variable1_new_value: variables.variable1_new_value,
          variable2_distance_to_gold: variables.variable2_distance_to_gold,
          variable3_distance_to_ref1: variables.variable3_distance_to_ref1,
          variable4_distance_to_ref2: variables.variable4_distance_to_ref2
        },
        validation_path: 'REF2'
      };
    }

    console.log(`❌ CHECK 3 FAILED: Distance to Ref2 = ${variables.variable4_distance_to_ref2.toFixed(4)} ≥ ${MAX_DISTANCE_TO_REF2}`);
    console.log(`❌❌ REJECTED: All distance checks failed (GOLD, REF1, REF2)`);
    console.log(`${'='.repeat(80)}\n`);

    return {
      matched: false,
      gold_standard,
      clarity: null,
      variables: {
        variable1_new_value: variables.variable1_new_value,
        variable2_distance_to_gold: variables.variable2_distance_to_gold,
        variable3_distance_to_ref1: variables.variable3_distance_to_ref1,
        variable4_distance_to_ref2: variables.variable4_distance_to_ref2
      },
      validation_path: 'NONE'
    };

  } catch (error) {
    console.error(`Error in circle validation for ${category}:`, error);
    return { 
      matched: false, 
      gold_standard: null, 
      clarity: null,
      variables: null,
      validation_path: 'NONE'
    };
  }
}

// ============================================================================
// ANALYSIS CLASS
// ============================================================================

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

    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP 1: INTENT ANALYSIS`);
    console.log(`${'='.repeat(80)}`);

    for (const [intent, patterns] of Object.entries(INTENT_DICTIONARY)) {
      for (const pattern of [...patterns.primary, ...patterns.synonyms]) {
        if (input.includes(pattern.toLowerCase())) {
          this.analysis.intent = {
            status: 'Clear',
            value: intent,
            reply: 'Your intent is clear.'
          };
          this.analysis.step1_reply = 'Your intent is clear.';
          intentFound = true;
          console.log(`✅ Intent found via primary dictionary: ${intent}`);
          break;
        }
      }
      if (intentFound) break;
    }

    if (!intentFound) {
      for (const [intent, phrases] of Object.entries(INTENT_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.intent = {
              status: 'Adequate Clarity',
              value: intent,
              reply: 'Your intent seems somewhat clear.'
            };
            this.analysis.step1_reply = 'Your intent seems somewhat clear.';
            intentFound = true;
            console.log(`✅ Intent found via phrase dictionary: ${intent}`);
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
        const gold_standard = validation_result.gold_standard;
        const detectedIntent = INTENT_PHRASE_TO_CATEGORY[gold_standard] || 'menu';
        
        this.analysis.intent = {
          status: validation_result.clarity,
          value: detectedIntent,
          reply: 'Your intent seems somewhat clear.'
        };
        this.analysis.step1_reply = 'Your intent seems somewhat clear.';
        intentFound = true;
        
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: 'intent',
            ...validation_result.variables,
            validation_path: validation_result.validation_path,
            acceptance_status: 'ACCEPTED'
          });
        }
        
        console.log(`✅ Intent validated via Qdrant: ${detectedIntent}`);
      } else {
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: 'intent',
            ...validation_result.variables,
            validation_path: validation_result.validation_path,
            acceptance_status: 'REJECTED'
          });
        }
      }
    }

    if (!intentFound) {
      if (this.hasAnyKeywords(input)) {
        this.analysis.intent = {
          status: 'Not Clear',
          value: '',
          reply: 'Unable to determine your intent.'
        };
        this.analysis.step1_reply = 'Unable to determine your intent.';
        console.log(`❌ Intent not clear`);
      } else {
        this.analysis.intent = {
          status: 'Not Found',
          value: '',
          reply: 'No intent detected.'
        };
        this.analysis.step1_reply = 'No intent detected.';
        console.log(`❌ Intent not found`);
      }
    }
  }

  async step2_processConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let processFound = false;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP 2: PROCESS ANALYSIS`);
    console.log(`${'='.repeat(80)}`);

    for (const [process, patterns] of Object.entries(PROCESS_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input === keyword.toLowerCase() || input.includes(keyword.toLowerCase())) {
          this.analysis.process = {
            status: 'Clear',
            value: process,
            reply: `Detected process is clear: ${process}`
          };
          this.analysis.step2_reply = `Detected process is clear: ${process}`;
          processFound = true;
          console.log(`✅ Process found via primary dictionary: ${process}`);
          break;
        }
      }
      if (processFound) break;
    }

    if (!processFound) {
      for (const [process, phrases] of Object.entries(PROCESS_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.process = {
              status: 'Adequate Clarity',
              value: process,
              reply: `Detected process is somewhat clear: ${process}`
            };
            this.analysis.step2_reply = `Detected process is somewhat clear: ${process}`;
            processFound = true;
            console.log(`✅ Process found via phrase dictionary: ${process}`);
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
          this.analysis.process = {
            status: validation_result.clarity,
            value: validation_result.gold_standard,
            reply: `Detected process is somewhat clear: ${validation_result.gold_standard}`
          };
          this.analysis.step2_reply = `Detected process is somewhat clear: ${validation_result.gold_standard}`;
          processFound = true;
          
          if (validation_result.variables) {
            this.analysis.validation_logs.push({
              component_type: 'process',
              ...validation_result.variables,
              validation_path: validation_result.validation_path,
              acceptance_status: 'ACCEPTED'
            });
          }
          
          console.log(`✅ Process validated via Qdrant: ${validation_result.gold_standard}`);
        } else {
          if (validation_result.variables) {
            this.analysis.validation_logs.push({
              component_type: 'process',
              ...validation_result.variables,
              validation_path: validation_result.validation_path,
              acceptance_status: 'REJECTED'
            });
          }
        }
      }
    }

    if (!processFound) {
      if (this.hasAnyKeywords(input)) {
        this.analysis.process = {
          status: 'Not Clear',
          value: '',
          reply: 'Unable to determine the process.'
        };
        this.analysis.step2_reply = 'Unable to determine the process.';
        console.log(`❌ Process not clear`);
      } else {
        this.analysis.process = {
          status: 'Not Found',
          value: '',
          reply: 'No process detected.'
        };
        this.analysis.step2_reply = 'No process detected.';
        console.log(`❌ Process not found`);
      }
    }
  }

  checkHelpRedirect() {
    const intentCategory = this.analysis.intent.value;
    const intentStatus = this.analysis.intent.status;
    const processValue = this.analysis.process.value;
    const processStatus = this.analysis.process.status;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP 2.5: HELP REDIRECT CHECK`);
    console.log(`${'='.repeat(80)}`);
    console.log(`Intent Category: ${intentCategory}, Status: ${intentStatus}`);
    console.log(`Process Value: ${processValue}, Status: ${processStatus}`);

    if (intentCategory === 'help' && 
        (intentStatus === 'Clear' || intentStatus === 'Adequate Clarity') &&
        (processStatus === 'Clear' || processStatus === 'Adequate Clarity')) {
      
      const redirect_url = PROCESS_REFERENCE_MAPPING[processValue];
      
      if (redirect_url) {
        this.analysis.finalAnalysis = `Redirecting you to the help documentation for ${processValue}.`;
        this.analysis.proceed_button = false;
        this.analysis.redirect_flag = true;
        this.analysis.redirect_url = redirect_url;
        
        console.log(`✅ Help redirect activated: ${redirect_url}`);
        return true;
      }
    }
    
    console.log(`No help redirect needed`);
    return false;
  }

  async step3_actionConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let actionFound = false;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP 3: ACTION ANALYSIS`);
    console.log(`${'='.repeat(80)}`);

    for (const [action, patterns] of Object.entries(ACTION_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input.includes(keyword.toLowerCase())) {
          this.analysis.action = {
            status: 'Clear',
            value: action,
            reply: `Detected action is clear: ${action}`
          };
          this.analysis.step3_reply = `Detected action is clear: ${action}`;
          actionFound = true;
          console.log(`✅ Action found via primary dictionary: ${action}`);
          break;
        }
      }
      if (actionFound) break;
    }

    if (!actionFound) {
      for (const [action, phrases] of Object.entries(ACTION_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.action = {
              status: 'Adequate Clarity',
              value: action,
              reply: `Detected action is somewhat clear: ${action}`
            };
            this.analysis.step3_reply = `Detected action is somewhat clear: ${action}`;
            actionFound = true;
            console.log(`✅ Action found via phrase dictionary: ${action}`);
            break;
          }
        }
        if (actionFound) break;
      }
    }

    if (!actionFound) {
      const searchText = extractActionText(input);
      if (searchText) {
        const validation_result = await performCircleValidation(searchText, 'action');

        if (validation_result.matched) {
          this.analysis.action = {
            status: validation_result.clarity,
            value: validation_result.gold_standard,
            reply: `Detected action is somewhat clear: ${validation_result.gold_standard}`
          };
          this.analysis.step3_reply = `Detected action is somewhat clear: ${validation_result.gold_standard}`;
          actionFound = true;
          
          if (validation_result.variables) {
            this.analysis.validation_logs.push({
              component_type: 'action',
              ...validation_result.variables,
              validation_path: validation_result.validation_path,
              acceptance_status: 'ACCEPTED'
            });
          }
          
          console.log(`✅ Action validated via Qdrant: ${validation_result.gold_standard}`);
        } else {
          if (validation_result.variables) {
            this.analysis.validation_logs.push({
              component_type: 'action',
              ...validation_result.variables,
              validation_path: validation_result.validation_path,
              acceptance_status: 'REJECTED'
            });
          }
        }
      }
    }

    if (!actionFound) {
      if (this.hasAnyKeywords(input)) {
        this.analysis.action = {
          status: 'Not Clear',
          value: '',
          reply: 'Unable to determine the action.'
        };
        this.analysis.step3_reply = 'Unable to determine the action.';
        console.log(`❌ Action not clear`);
      } else {
        this.analysis.action = {
          status: 'Not Found',
          value: '',
          reply: 'No action detected.'
        };
        this.analysis.step3_reply = 'No action detected.';
        console.log(`❌ Action not found`);
      }
    }
  }

  async step4_filterAnalysis(userInput) {
    const input = userInput.toLowerCase().trim();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP 4: FILTER ANALYSIS`);
    console.log(`${'='.repeat(80)}`);

    const intentCategory = this.analysis.intent.value;
    const actionValue = this.analysis.action.value;

    console.log(`Intent Category: ${intentCategory}`);
    console.log(`Action Value: ${actionValue}`);

    if (intentCategory !== 'menu' || (actionValue !== 'modify' && actionValue !== 'search')) {
      this.analysis.filters = {
        status: 'Not Applicable',
        value: [],
        reply: 'Filters not applicable.'
      };
      this.analysis.step4_reply = 'Filters not applicable.';
      console.log(`Filters not applicable for this intent/action combination`);
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
      this.analysis.filters = {
        status: 'Not Found',
        value: [],
        reply: 'No filters detected.'
      };
      this.analysis.step4_reply = 'No filters detected.';
      console.log(`No filters detected in input`);
      return;
    }

    console.log(`\nDetected ${detectedFilters.length} filter(s)`);

    for (let i = 0; i < detectedFilters.length; i++) {
      const filter = detectedFilters[i];
      console.log(`\n--- Processing Filter ${i + 1} ---`);
      console.log(`Name: "${filter.name}", Operator: "${filter.operator}", Value: "${filter.value}"`);

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
      this.analysis.filters.status = 'Clear';
      this.analysis.filters.reply = 'Filters are clear.';
      this.analysis.step4_reply = 'Filters are clear.';
    } else if (someValid) {
      this.analysis.filters.status = 'Adequate Clarity';
      this.analysis.filters.reply = 'Filters have adequate clarity.';
      this.analysis.step4_reply = 'Filters have adequate clarity.';
    } else {
      this.analysis.filters.status = 'Not Clear';
      this.analysis.filters.reply = 'Filters are not clear.';
      this.analysis.step4_reply = 'Filters are not clear.';
    }

    console.log(`\nFinal Filter Status: ${this.analysis.filters.status}`);
  }

  async analyzeFilterComponent(filter, componentKey, category, dictionary, phraseDictionary) {
    const componentValue = filter[componentKey];
    const statusKey = `${componentKey}_status`;
    let found = false;

    console.log(`\n  Analyzing ${componentKey}: "${componentValue}"`);

    for (const [standardValue, patterns] of Object.entries(dictionary)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (componentValue === keyword.toLowerCase() || componentValue.includes(keyword.toLowerCase())) {
          filter[statusKey] = 'Clear';
          filter[componentKey] = standardValue;
          found = true;
          console.log(`  ✅ Found via primary dictionary: ${standardValue}`);
          break;
        }
      }
      if (found) break;
    }

    if (!found && phraseDictionary) {
      for (const [standardValue, phrases] of Object.entries(phraseDictionary)) {
        for (const phrase of phrases) {
          if (componentValue.includes(phrase.toLowerCase())) {
            filter[statusKey] = 'Adequate Clarity';
            filter[componentKey] = standardValue;
            found = true;
            console.log(`  ✅ Found via phrase dictionary: ${standardValue}`);
            break;
          }
        }
        if (found) break;
      }
    }

    if (!found) {
      const validation_result = await performCircleValidation(componentValue, category);

      if (validation_result.matched) {
        filter[statusKey] = validation_result.clarity;
        filter[componentKey] = validation_result.gold_standard;
        found = true;
        
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: category,
            ...validation_result.variables,
            validation_path: validation_result.validation_path,
            acceptance_status: 'ACCEPTED'
          });
        }
        
        console.log(`  ✅ Validated via Qdrant: ${validation_result.gold_standard}`);
      } else {
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: category,
            ...validation_result.variables,
            validation_path: validation_result.validation_path,
            acceptance_status: 'REJECTED'
          });
        }
      }
    }

    if (!found) {
      filter[statusKey] = 'Not Clear';
      console.log(`  ❌ ${componentKey} not found`);
    }
  }

  step5_finalAnalysis() {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP 5: FINAL ANALYSIS`);
    console.log(`${'='.repeat(80)}`);

    const intentStatus = this.analysis.intent.status;
    const processStatus = this.analysis.process.status;
    const actionStatus = this.analysis.action.status;
    const filterStatus = this.analysis.filters.status;

    const intentValue = this.analysis.intent.value;
    const processValue = this.analysis.process.value;
    const actionValue = this.analysis.action.value;

    const allValid = 
      (intentStatus === 'Clear' || intentStatus === 'Adequate Clarity') &&
      (processStatus === 'Clear' || processStatus === 'Adequate Clarity') &&
      (actionStatus === 'Clear' || actionStatus === 'Adequate Clarity') &&
      (filterStatus === 'Clear' || filterStatus === 'Adequate Clarity' || filterStatus === 'Not Applicable' || filterStatus === 'Not Found');

    if (allValid) {
      let filterText = '';
      if (filterStatus === 'Clear' || filterStatus === 'Adequate Clarity') {
        const filterDescriptions = this.analysis.filters.value.map(f => 
          `${f.name} ${f.operator} ${f.value}`
        ).join(', ');
        filterText = ` with filters: ${filterDescriptions}`;
      }

      this.analysis.finalAnalysis = `Your intent is clear to ${actionValue} on ${processValue}${filterText}.`;
      this.analysis.proceed_button = true;
      console.log(`✅ Analysis complete - All components valid`);
    } else {
      let failures = [];
      if (intentStatus !== 'Clear' && intentStatus !== 'Adequate Clarity') {
        failures.push('intent');
      }
      if (processStatus !== 'Clear' && processStatus !== 'Adequate Clarity') {
        failures.push('process');
      }
      if (actionStatus !== 'Clear' && actionStatus !== 'Adequate Clarity') {
        failures.push('action');
      }
      if (filterStatus === 'Not Clear') {
        failures.push('filters');
      }

      this.analysis.finalAnalysis = `Unable to determine the following: ${failures.join(', ')}.`;
      this.analysis.proceed_button = false;

      if (intentValue === 'menu') {
        this.analysis.suggested_action = 'Please rephrase using clear action words like "create", "modify", "search", or "delete".';
        this.analysis.example_query = 'Example: "I want to create an objective"';
      } else if (intentValue === 'help') {
        this.analysis.suggested_action = 'Please specify what you need help with.';
        this.analysis.example_query = 'Example: "How do I create an objective?"';
      } else {
        this.analysis.suggested_action = 'Please rephrase your request more clearly.';
        this.analysis.example_query = 'Example: "I want to create an objective"';
      }

      console.log(`❌ Analysis incomplete - Failed components: ${failures.join(', ')}`);
    }

    console.log(`Final Analysis: ${this.analysis.finalAnalysis}`);
    console.log(`Proceed Button: ${this.analysis.proceed_button}`);
  }

  async analyze(userInput) {
    this.reset();
    this.analysis.userInput = userInput;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`STARTING ANALYSIS FOR: "${userInput}"`);
    console.log(`${'='.repeat(80)}`);

    await this.step1_intentConclusion(userInput);
    await this.step2_processConclusion(userInput);

    if (this.checkHelpRedirect()) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`ANALYSIS COMPLETE - HELP REDIRECT`);
      console.log(`${'='.repeat(80)}\n`);
      return this.analysis;
    }

    await this.step3_actionConclusion(userInput);
    await this.step4_filterAnalysis(userInput);
    this.step5_finalAnalysis();

    console.log(`\n${'='.repeat(80)}`);
    console.log(`ANALYSIS COMPLETE`);
    console.log(`${'='.repeat(80)}\n`);

    return this.analysis;
  }
}

// ============================================================================
// API ENDPOINTS
// ============================================================================

app.post('/api/analyze', async (req, res) => {
  try {
    const { sentence } = req.body;

    if (!sentence || sentence.trim() === '') {
      return res.status(400).json({
        success: false,
        error: 'Sentence is required'
      });
    }

    console.log(`\n${'#'.repeat(80)}`);
    console.log(`NEW ANALYSIS REQUEST`);
    console.log(`Sentence: "${sentence}"`);
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`${'#'.repeat(80)}`);

    const analyzer = new ConversationAnalyzer();
    const analysis = await analyzer.analyze(sentence);

    const logEntry = {
      timestamp: new Date().toISOString(),
      sentence: sentence,
      analysis: analysis,
      validation_logs: analysis.validation_logs
    };
    logs.push(logEntry);

    if (logs.length > 100) {
      logs.shift();
    }

    res.json({
      success: true,
      analysis: analysis
    });

  } catch (error) {
    console.error('Error in /api/analyze:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message
    });
  }
});

app.get('/api/logs', (req, res) => {
  res.json({
    success: true,
    logs: logs
  });
});

app.post('/api/logs/clear', (req, res) => {
  logs.length = 0;
  res.json({
    success: true,
    message: 'Logs cleared'
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SERVER STARTED`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Sequential Validation: ENABLED`);
  console.log(`Safety Floor: ${SAFETY_FLOOR}`);
  console.log(`Max Distance to Gold: ${MAX_DISTANCE_TO_GOLD}`);
  console.log(`Max Distance to Ref1: ${MAX_DISTANCE_TO_REF1}`);
  console.log(`Max Distance to Ref2: ${MAX_DISTANCE_TO_REF2}`);
  console.log(`${'='.repeat(80)}\n`);
});