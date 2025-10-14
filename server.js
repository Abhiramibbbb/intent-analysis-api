require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qdrantService = require('./qdrant-service');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// CIRCLE VALIDATION CONSTANTS
// ============================================================================

const SAFETY_FLOOR = 0.30;
const MAX_DISTANCE_TO_GOLD = 0.30;
const MAX_DISTANCE_TO_REF1 = 0.15;
const MAX_DISTANCE_TO_REF2 = 0.15;

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
// CORE CIRCLE VALIDATION FUNCTION
// ============================================================================

async function performCircleValidation(searchText, category) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`CIRCLE VALIDATION: ${category.toUpperCase()}`);
  console.log(`Search Text: "${searchText}"`);
  console.log(`${'='.repeat(80)}`);

  // Map category names
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
    // Query Qdrant for top matches
    const results = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);

    if (!results || !results.match) {
      console.log(`❌ No Qdrant results found for ${category}`);
      return { matched: false, gold_standard: null, clarity: null };
    }

    // Extract top match
    const gold_standard = results.match;
    const new_to_gold_score = results.score;

    console.log(`\nTop Match: "${gold_standard}" (score: ${new_to_gold_score.toFixed(4)})`);

    // ========================================================================
    // CONDITION 1: Safety Floor Check
    // ========================================================================

    console.log(`\n--- CONDITION 1: Safety Floor Check ---`);
    if (new_to_gold_score < SAFETY_FLOOR) {
      console.log(`❌ C1 FAILED: ${new_to_gold_score.toFixed(4)} < ${SAFETY_FLOOR} (rejected outside circle)`);
      return { matched: false, gold_standard, clarity: null };
    }

    console.log(`✅ C1 PASSED: ${new_to_gold_score.toFixed(4)} ≥ ${SAFETY_FLOOR} (entered circle)`);

    // ========================================================================
    // Get Reference Phrases and Scores
    // ========================================================================

    const ref1_phrase = REFERENCE_MAPPINGS[qdrantCategory]?.ref1[gold_standard];
    const ref2_phrase = REFERENCE_MAPPINGS[qdrantCategory]?.ref2[gold_standard];

    if (!ref1_phrase || !ref2_phrase) {
      console.log(`⚠️ Reference phrases not found for "${gold_standard}"`);
      return { matched: false, gold_standard, clarity: null };
    }

    console.log(`\nReferences: Ref1="${ref1_phrase}", Ref2="${ref2_phrase}"`);

    // Query for Ref1 and Ref2 scores
    const ref1_result = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);
    const ref2_result = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);

    // Find scores in results or query specifically
    let new_to_ref1_score = findScoreInResults(ref1_result, ref1_phrase) || 0;
    let new_to_ref2_score = findScoreInResults(ref2_result, ref2_phrase) || 0;

    // Get pre-calculated scores
    const gold_to_ref1_score = GOLD_TO_REF_SCORES[qdrantCategory]?.ref1[gold_standard] || 0;
    const gold_to_ref2_score = GOLD_TO_REF_SCORES[qdrantCategory]?.ref2[gold_standard] || 0;

    console.log(`\nScores:`);
    console.log(`  new→ref1: ${new_to_ref1_score.toFixed(4)}, gold→ref1: ${gold_to_ref1_score.toFixed(4)}`);
    console.log(`  new→ref2: ${new_to_ref2_score.toFixed(4)}, gold→ref2: ${gold_to_ref2_score.toFixed(4)}`);

    // ========================================================================
    // CONDITION 2: Distance Validation (3 checks)
    // ========================================================================

    console.log(`\n--- CONDITION 2: Distance Validation ---`);

    // Part 2A: Distance to Gold
    const distance_to_gold = 1.0 - new_to_gold_score;
    const condition2a = distance_to_gold < MAX_DISTANCE_TO_GOLD;
    console.log(`Part 2A - Distance to Gold: ${distance_to_gold.toFixed(4)} < ${MAX_DISTANCE_TO_GOLD}? ${condition2a ? '✅ PASS' : '❌ FAIL'}`);

    // Part 2B: Distance to Ref1
    const distance_to_ref1 = Math.abs(new_to_ref1_score - gold_to_ref1_score);
    const condition2b = distance_to_ref1 < MAX_DISTANCE_TO_REF1;
    console.log(`Part 2B - Distance to Ref1: ${distance_to_ref1.toFixed(4)} < ${MAX_DISTANCE_TO_REF1}? ${condition2b ? '✅ PASS' : '❌ FAIL'}`);

    // Part 2C: Distance to Ref2
    const distance_to_ref2 = Math.abs(new_to_ref2_score - gold_to_ref2_score);
    const condition2c = distance_to_ref2 < MAX_DISTANCE_TO_REF2;
    console.log(`Part 2C - Distance to Ref2: ${distance_to_ref2.toFixed(4)} < ${MAX_DISTANCE_TO_REF2}? ${condition2c ? '✅ PASS' : '❌ FAIL'}`);

    // Final Condition 2 Check
    const condition2_passed = condition2a || condition2b || condition2c;

    // ========================================================================
    // FINAL VALIDATION
    // ========================================================================

    console.log(`\n--- FINAL VALIDATION ---`);
    if (condition2_passed) {
      console.log(`✅ C2 PASSED: At least one distance check passed`);
      console.log(`✅✅ ACCEPTED: "${gold_standard}"`);
      console.log(`${'='.repeat(80)}\n`);
      return {
        matched: true,
        gold_standard,
        clarity: 'Adequate Clarity'
      };
    } else {
      console.log(`❌ C2 FAILED: All distance checks failed`);
      console.log(`❌❌ REJECTED: "${gold_standard}"`);
      console.log(`${'='.repeat(80)}\n`);
      return {
        matched: false,
        gold_standard,
        clarity: null
      };
    }

  } catch (error) {
    console.error(`Error in circle validation for ${category}:`, error);
    return { matched: false, gold_standard: null, clarity: null };
  }
}

function findScoreInResults(results, targetText) {
  if (!results || !results.match) return null;
  if (results.match === targetText) return results.score;
  return null;
}

// ============================================================================
// TEXT EXTRACTION FUNCTIONS
// ============================================================================

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
      step4_reply: ''
    };
  }

  // Step 1: Intent Conclusion
  async step1_intentConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let intentFound = false;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP 1: INTENT ANALYSIS`);
    console.log(`${'='.repeat(80)}`);

    // 1.1 Programmatic Check - Primary/Synonym
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

    // 1.2 Programmatic Check - Phrase Dictionary
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

    // 1.3 Qdrant Circle Validation
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
        console.log(`✅ Intent validated via Qdrant: ${detectedIntent}`);
      }
    }

    // 1.4 No Intent Detected
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

  // Step 2: Process Conclusion
  async step2_processConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let processFound = false;

    console.log(`\n${'='.repeat(80)}`);
    console.log(`STEP 2: PROCESS ANALYSIS`);
    console.log(`${'='.repeat(80)}`);

    // 2.1 Programmatic Check - Primary/Synonym
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

    // 2.2 Programmatic Check - Phrase Dictionary
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

    // 2.3 Qdrant Circle Validation
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
          console.log(`✅ Process validated via Qdrant: ${validation_result.gold_standard}`);
        }
      }
    }

    // 2.4 No Process Detected
    if (!processFound) {
      if (this.hasAnyKeywords(input)) {
        this.analysis.process = {
          status: 'Not Clear',
          value: '',
          reply: 'Unable to determine the process