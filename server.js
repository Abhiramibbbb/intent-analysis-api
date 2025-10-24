require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const qdrantService = require('./qdrant-service');

const app = express();
const PORT = process.env.PORT || 3000;

// Constants from Pseudocode - EXACT VALUES FROM PSEUDOCODE
const SAFETY_FLOOR = 0.30;
const MAX_DISTANCE_TO_GOLD = 0.5;
const MAX_DISTANCE_TO_REF1 = 0.4;   // Changed from 0.15 to 0.2 as per pseudocode
const MAX_DISTANCE_TO_REF2 = 0.3;   // Changed from 0.15 to 0.1 as per pseudocode

const logs = [];

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/docs', express.static('docs'));

// Reference Mappings - EXACT FROM PSEUDOCODE
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
    ref1: { 'today': 'this day', 'high': 'critical', 'pending': 'ongoing', 'q1': 'first quarter' },
    ref2: { 'today': 'current date', 'high': 'top priority', 'pending': 'unfinished', 'q1': 'Q one' }
  }
};

// Pre-calculated Gold→Ref1 Scores - EXACT FROM PSEUDOCODE
const GOLD_TO_REF1_SCORES = {
  intent: { 'i want to': 0.9, 'how do i': 0.95 },
  action: { 'create': 0.9, 'modify': 0.95, 'search': 0.85, 'delete': 0.95 },
  process: { 'objective': 0.85, 'key result': 0.5, 'initiative': 0.4, 'review meeting': 0.8, 'key result checkin': 0.9 },
  filter_name: { 'due': 0.8, 'priority': 0.8, 'status': 0.7, 'assigned': 0.75, 'quarter': 0.3942 },
  filter_operator: { 'equal to': 1, 'greater than': 1, 'less than': 1 },
  filter_value: { 'today': 0.7743, 'high': 0.3951, 'pending': 0.5588, 'q1': 0.3209 }
};

// Pre-calculated Gold→Ref2 Scores - EXACT FROM PSEUDOCODE
const GOLD_TO_REF2_SCORES = {
  intent: { 'i want to': 0.98, 'how do i': 0.9 },
  action: { 'create': 0.6, 'modify': 0.9, 'search': 0.8, 'delete': 0.85 },
  process: { 'objective': 0.5, 'key result': 0.5, 'initiative': 0.3, 'review meeting': 0.7, 'key result checkin': 0.1245 },
  filter_name: { 'due': 0.3, 'priority': 0.8, 'status': 0.7, 'assigned': 0.9, 'quarter': 0.2 },
  filter_operator: { 'equal to': 1, 'greater than': 1, 'less than': 1 },
  filter_value: { 'today': 0.8571, 'high': 0.7103, 'pending': 0.5231, 'q1': 0.3022 }
};

// Category to Gold Standard Phrase Mapping
const CATEGORY_TO_GOLD_PHRASE = {
  'intent': { 'menu': 'i want to', 'help': 'how do i' },
  'process': { 'objective': 'objective', 'key result': 'key result', 'initiative': 'initiative', 'review meeting': 'review meeting', 'key result checkin': 'key result checkin' },
  'action': { 'create': 'create', 'modify': 'modify', 'search': 'search', 'delete': 'delete' },
  'filter_name': { 'due': 'due', 'priority': 'priority', 'status': 'status', 'assigned': 'assigned', 'quarter': 'quarter' },
  'filter_operator': { 'equal to': 'equal to', 'greater than': 'greater than', 'less than': 'less than' },
  'filter_value': { 'today': 'today', 'high': 'high', 'pending': 'pending', 'q1': 'q1' }
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
  'equal to': { primary: ['=', 'equals', 'is'], synonyms: ['equal to', 'exactly'] },
  'greater than': { primary: ['>', 'greater than'], synonyms: ['more than'] },
  'less than': { primary: ['<', 'less than'], synonyms: ['below'] }
};

const FILTER_VALUE_DICTIONARY = {
  'today': { primary: ['today'], synonyms: ['this day', 'current date'] },
  'tomorrow': { primary: ['tomorrow'], synonyms: [] },
  'yesterday': { primary: ['yesterday'], synonyms: [] },
  'high': { primary: ['high'], synonyms: ['critical', 'top priority', 'urgent'] },
  'low': { primary: ['low'], synonyms: ['minor'] },
  'medium': { primary: ['medium'], synonyms: ['normal'] },
  'pending': { primary: ['pending'], synonyms: ['ongoing', 'unfinished', 'in progress', 'open'] },
  'completed': { primary: ['completed'], synonyms: ['done', 'closed'] },
  'q1': { primary: ['q1'], synonyms: ['quarter 1', 'first quarter', 'Q one'] },
  'q2': { primary: ['q2'], synonyms: ['quarter 2'] },
  'q3': { primary: ['q3'], synonyms: ['quarter 3'] },
  'q4': { primary: ['q4'], synonyms: ['quarter 4'] }
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
  'assigned': ['who is responsible', 'assigned person', 'task owner'],
  'quarter': ['reporting period']
};

const FILTER_OPERATOR_PHRASE_DICTIONARY = {
  'equal to': ['same as', 'matches', 'is exactly', 'exactly'],
  'greater than': ['exceeds', 'higher than', 'above'],
  'less than': ['under', 'lower than', 'lesser than']
};

const FILTER_VALUE_PHRASE_DICTIONARY = {
  'this week': ['this week'],
  'next week': ['next week'],
  'last week': ['last week'],
  'high': ['urgent'],
  'medium': ['normal'],
  'low': ['minor'],
  'pending': ['in progress', 'open'],
  'completed': ['closed']
};

const FILTER_PATTERNS = [
  /([\w\s-]+)\s*(=|\bequals\b|\bis\b|\bequal to\b|\bexactly\b|\bis exactly\b)\s*([^\s,]+)/gi,
  /([\w\s-]+)\s*(>|\bgreater than\b|\bmore than\b|\babove\b)\s*([^\s,]+)/gi,
  /([\w\s-]+)\s*(<|\bless than\b|\bbelow\b|\bunder\b)\s*([^\s,]+)/gi,
  /(due|priority|status|assigned)\s+(today|tomorrow|yesterday|high|low|medium|pending|completed|[^\s,]+)/gi,
  /where\s+([\w\s-]+)\s*(=|>|<|\bequals\b|\bis\b|\bexactly\b|\bis exactly\b)\s*([^\s,]+)/gi,
  /(quarter|q)\s*(=|\bequals\b|\bis\b|\bequal to\b|\bexactly\b|\bis exactly\b)\s*(q?[1-4])/gi,
  /for\s+(quarter|q)\s*(q?[1-4])/gi
];

function extractIntentText(userInput) {
  const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find'];
  for (const verb of actionVerbs) {
    const position = userInput.toLowerCase().indexOf(verb);
    if (position > 0) return userInput.substring(0, position).trim();
  }
  return userInput.split(' ').slice(0, 4).join(' ');
}

function extractProcessText(userInput) {
  const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find', 'generate', 'change', 'locate', 'erase', 'construct', 'draft', 'build', 'establish', 'develop'];
  const lowerInput = userInput.toLowerCase();
  let earliestPosition = -1;
  let foundVerb = '';
  
  // Find earliest action verb
  for (const verb of actionVerbs) {
    const position = lowerInput.indexOf(verb);
    if (position !== -1) {
      if (earliestPosition === -1 || position < earliestPosition) {
        earliestPosition = position;
        foundVerb = verb;
      }
    }
  }
  
  if (earliestPosition >= 0) {
    let afterVerb = userInput.substring(earliestPosition + foundVerb.length).trim();
    
    // Check multi-word processes FIRST
    const multiWordProcesses = ['key result checkin', 'review meeting', 'key result'];
    for (const process of multiWordProcesses) {
      if (afterVerb.toLowerCase().startsWith(process)) {
        console.log(`[EXTRACT] Found multi-word process: "${process}"`);
        return process;
      }
    }
    
    // Remove filter keywords FIRST
    const filterKeywords = ['with', 'where', 'having', 'for'];
    for (const keyword of filterKeywords) {
      const keywordPos = afterVerb.toLowerCase().indexOf(' ' + keyword + ' ');
      if (keywordPos >= 0) {
        afterVerb = afterVerb.substring(0, keywordPos).trim();
        console.log(`[EXTRACT] After filter removal: "${afterVerb}"`);
        break;
      }
    }
    
    // Extract ONLY first 1-2 words
    const words = afterVerb.split(/\s+/);
    
    // Check if first 2 words form multi-word process
    if (words.length >= 2) {
      const twoWords = `${words[0]} ${words[1]}`.toLowerCase();
      if (multiWordProcesses.includes(twoWords)) {
        console.log(`[EXTRACT] 2-word process: "${twoWords}"`);
        return twoWords;
      }
    }
    
    // Return first word only
    const processWord = words[0] || '';
    console.log(`[EXTRACT] Single-word process: "${processWord}"`);
    return processWord;
  }
  
  // Simplified fallback
  const intentPhrases = ['i want to', 'i need to', 'i would like to', 'i wish to', 'i intend to', 
                         "i'm looking to", "i'm trying to", 'i am preparing to', 'i am planning to',
                         'i am aiming to', 'i am hoping to', 'i feel ready to',
                         'how do i', 'how can i', 'show me how', 'how to'];
  
  for (const phrase of intentPhrases) {
    const phraseIndex = lowerInput.indexOf(phrase);
    if (phraseIndex !== -1) {
      const afterIntent = lowerInput.substring(phraseIndex + phrase.length).trim();
      const words = afterIntent.split(/\s+/);
      
      // Skip first word (action), return second word (process)
      if (words.length >= 2) {
        console.log(`[EXTRACT] Fallback process: "${words[1]}"`);
        return words[1];
      }
    }
  }
  
  console.log(`[EXTRACT] No process found`);
  return '';
}

function extractActionText(userInput) {
  const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find', 'generate', 'change', 'locate', 'erase', 'construct', 'draft'];
  const lowerInput = userInput.toLowerCase();
  
  // First, try to find known action verbs
  let earliestPosition = -1;
  let foundVerb = '';
  for (const verb of actionVerbs) {
    const position = lowerInput.indexOf(verb);
    if (position !== -1) {
      if (earliestPosition === -1 || position < earliestPosition) {
        earliestPosition = position;
        foundVerb = verb;
      }
    }
  }
  
  if (foundVerb) {
    return foundVerb;
  }
  
  // If no known verb found, extract word after intent phrase
  const intentPhrases = ['i want to', 'i need to', 'i would like to', 'i wish to', 'i intend to', 
                         "i'm looking to", "i'm trying to", 'i am preparing to', 'i am planning to',
                         'i am aiming to', 'i am hoping to', 'i feel ready to',
                         'how do i', 'how can i', 'show me how to', 'how to'];
  
  for (const phrase of intentPhrases) {
    if (lowerInput.includes(phrase)) {
      const afterIntent = lowerInput.split(phrase)[1]?.trim();
      if (afterIntent) {
        const firstWord = afterIntent.split(' ')[0];
        if (firstWord && firstWord.length > 0) {
          return firstWord; // Return "establish", "develop", "build", etc.
        }
      }
    }
  }
  
  return '';
}

// Helper function to ensure reference phrases exist in Qdrant
async function ensureReferencePhrasesExist(ref1_phrase, ref2_phrase, gold_standard, qdrantCategory) {
  try {
    console.log(`[VALIDATION] Checking if ref phrases exist in Qdrant...`);
    
    // Check if ref1 exists
    const ref1Check = await qdrantService.searchSimilar(ref1_phrase, qdrantCategory, 100, 0.0);
    let ref1Exists = false;
    
    if (ref1Check && ref1Check.all_results) {
      ref1Exists = ref1Check.all_results.some(r => 
        r.match.toLowerCase() === ref1_phrase.toLowerCase()
      );
    }
    
    // Check if ref2 exists
    const ref2Check = await qdrantService.searchSimilar(ref2_phrase, qdrantCategory, 100, 0.0);
    let ref2Exists = false;
    
    if (ref2Check && ref2Check.all_results) {
      ref2Exists = ref2Check.all_results.some(r => 
        r.match.toLowerCase() === ref2_phrase.toLowerCase()
      );
    }
    
    console.log(`[VALIDATION] Ref1 "${ref1_phrase}" exists: ${ref1Exists}`);
    console.log(`[VALIDATION] Ref2 "${ref2_phrase}" exists: ${ref2Exists}`);
    
    // Add missing reference phrases
    if (!ref1Exists) {
      console.log(`[VALIDATION] ⚠️  Adding missing Ref1: "${ref1_phrase}"`);
      await qdrantService.addPhrase(ref1_phrase, qdrantCategory, gold_standard);
    }
    
    if (!ref2Exists) {
      console.log(`[VALIDATION] ⚠️  Adding missing Ref2: "${ref2_phrase}"`);
      await qdrantService.addPhrase(ref2_phrase, qdrantCategory, gold_standard);
    }
    
    return { ref1Exists, ref2Exists, ref1Added: !ref1Exists, ref2Added: !ref2Exists };
  } catch (error) {
    console.error(`[VALIDATION] Error ensuring ref phrases exist:`, error.message);
    return { ref1Exists: false, ref2Exists: false, ref1Added: false, ref2Added: false };
  }
}

async function performCircleValidation(searchText, category) {
  const categoryMap = {
    'intent': 'intent', 'process': 'process', 'action': 'action',
    'filter_name': 'filter_name', 'filter_operator': 'filter_operator', 'filter_value': 'filter_value',
    'filter name': 'filter_name', 'filter operator': 'filter_operator', 'filter value': 'filter_value'
  };
  const qdrantCategory = categoryMap[category] || category;
  
  console.log(`\n${'='.repeat(80)}`);
  console.log(`[VALIDATION] START - ${qdrantCategory.toUpperCase()}`);
  console.log(`[VALIDATION] Search Text: "${searchText}"`);
  console.log(`${'='.repeat(80)}`);

  try {
    const results = await qdrantService.searchSimilar(searchText, qdrantCategory, 10, 0.0);
    
    if (!results || !results.match) {
      console.log(`[VALIDATION] ❌ No match found`);
      console.log(`${'='.repeat(80)}\n`);
      return { matched: false, gold_standard: null, clarity: null, variables: null, validation_path: 'NONE' };
    }

    let categoryResult = results.match.toLowerCase();
    const new_to_gold_score = results.score;
    let gold_standard = categoryResult;
    
    if (CATEGORY_TO_GOLD_PHRASE[qdrantCategory]?.[categoryResult]) {
      gold_standard = CATEGORY_TO_GOLD_PHRASE[qdrantCategory][categoryResult];
      console.log(`[VALIDATION] ✓ Mapped "${results.match}" → "${gold_standard}"`);
    }
    
    console.log(`\n[VALIDATION] === BEST MATCH ===`);
    console.log(`   Gold Standard: "${gold_standard}"`);
    console.log(`   Score: ${new_to_gold_score.toFixed(4)}`);

    console.log(`\n[VALIDATION] ┌─ CONDITION 1: Safety Floor`);
    if (new_to_gold_score < SAFETY_FLOOR) {
      console.log(`[VALIDATION] └─ ❌ FAILED: ${new_to_gold_score.toFixed(4)} < ${SAFETY_FLOOR}`);
      console.log(`${'='.repeat(80)}\n`);
      return { matched: false, gold_standard, clarity: null, variables: null, validation_path: 'NONE' };
    }
    console.log(`[VALIDATION] └─ ✅ PASSED: ${new_to_gold_score.toFixed(4)} ≥ ${SAFETY_FLOOR}`);

    const variables = {
      variable1_new_value: searchText,
      variable2_distance_to_gold: 1.0 - new_to_gold_score,
      variable3_distance_to_ref1: null,
      variable4_distance_to_ref2: null
    };

    const ref1_phrase = REFERENCE_MAPPINGS[qdrantCategory]?.ref1[gold_standard.toLowerCase()];
    const ref2_phrase = REFERENCE_MAPPINGS[qdrantCategory]?.ref2[gold_standard.toLowerCase()];

    if (!ref1_phrase || !ref2_phrase) {
      console.log(`[VALIDATION] ❌ No references found for "${gold_standard}"`);
      console.log(`${'='.repeat(80)}\n`);
      return { matched: false, gold_standard, clarity: null, variables: null, validation_path: 'NONE' };
    }

    console.log(`\n[VALIDATION] === REFERENCES ===`);
    console.log(`   Ref1: "${ref1_phrase}"`);
    console.log(`   Ref2: "${ref2_phrase}"`);

    // Ensure ref1 and ref2 exist in Qdrant
    await ensureReferencePhrasesExist(ref1_phrase, ref2_phrase, gold_standard, qdrantCategory);

    console.log(`\n[VALIDATION] ┌─ CHECK 2A: Distance to Gold (< ${MAX_DISTANCE_TO_GOLD})`);
    console.log(`[VALIDATION] │  Distance: ${variables.variable2_distance_to_gold.toFixed(4)}`);
    
    if (variables.variable2_distance_to_gold < MAX_DISTANCE_TO_GOLD) {
      console.log(`[VALIDATION] └─ ✅ PASSED`);
      console.log(`[VALIDATION] 🎉 ACCEPTED via GOLD`);
      console.log(`${'='.repeat(80)}\n`);
      return {
        matched: true, gold_standard, clarity: 'Adequate Clarity',
        variables: { ...variables, variable3_distance_to_ref1: null, variable4_distance_to_ref2: null },
        validation_path: 'GOLD'
      };
    }
    console.log(`[VALIDATION] └─ ❌ FAILED`);

    console.log(`\n[VALIDATION] ┌─ CHECK 2B: Distance to Ref1 (< ${MAX_DISTANCE_TO_REF1})`);
    
    // Search for ref1 phrase with increased limit to find it
    const ref1_results = await qdrantService.searchSimilar(searchText, qdrantCategory, 100, 0.0);
    let new_to_ref1_score = 0;
    
    console.log(`[VALIDATION] │  Looking for ref1: "${ref1_phrase}"`);
    
    if (ref1_results && ref1_results.all_results) {
      const ref1Match = ref1_results.all_results.find(r => 
        r.match.toLowerCase() === ref1_phrase.toLowerCase()
      );
      
      if (ref1Match) {
        new_to_ref1_score = ref1Match.score;
        console.log(`[VALIDATION] │  ✓ Found ref1 in results`);
      } else {
        console.log(`[VALIDATION] │  ⚠️  Ref1 not found in top 100 results`);
        // If not found, try direct search
        const directRef1 = await qdrantService.searchSimilar(ref1_phrase, qdrantCategory, 1, 0.0);
        if (directRef1 && directRef1.score) {
          new_to_ref1_score = directRef1.score;
          console.log(`[VALIDATION] │  ✓ Got ref1 score via direct search`);
        }
      }
    }
    
    const gold_to_ref1_score = GOLD_TO_REF1_SCORES[qdrantCategory]?.[gold_standard.toLowerCase()] || 0;
    variables.variable3_distance_to_ref1 = Math.abs(new_to_ref1_score - gold_to_ref1_score);
    
    console.log(`[VALIDATION] │  New→Ref1 Score: ${new_to_ref1_score.toFixed(4)}`);
    console.log(`[VALIDATION] │  Gold→Ref1 Score: ${gold_to_ref1_score.toFixed(4)}`);
    console.log(`[VALIDATION] │  Distance: ${variables.variable3_distance_to_ref1.toFixed(4)}`);

    if (variables.variable3_distance_to_ref1 < MAX_DISTANCE_TO_REF1) {
      console.log(`[VALIDATION] └─ ✅ PASSED`);
      console.log(`[VALIDATION] 🎉 ACCEPTED via REF1`);
      console.log(`${'='.repeat(80)}\n`);
      return {
        matched: true, gold_standard, clarity: 'Adequate Clarity',
        variables: { ...variables, variable4_distance_to_ref2: null },
        validation_path: 'REF1'
      };
    }
    console.log(`[VALIDATION] └─ ❌ FAILED`);

    console.log(`\n[VALIDATION] ┌─ CHECK 2C: Distance to Ref2 (< ${MAX_DISTANCE_TO_REF2})`);
    
    // Search for ref2 phrase with increased limit to find it
    const ref2_results = await qdrantService.searchSimilar(searchText, qdrantCategory, 100, 0.0);
    let new_to_ref2_score = 0;
    
    console.log(`[VALIDATION] │  Looking for ref2: "${ref2_phrase}"`);
    
    if (ref2_results && ref2_results.all_results) {
      const ref2Match = ref2_results.all_results.find(r => 
        r.match.toLowerCase() === ref2_phrase.toLowerCase()
      );
      
      if (ref2Match) {
        new_to_ref2_score = ref2Match.score;
        console.log(`[VALIDATION] │  ✓ Found ref2 in results`);
      } else {
        console.log(`[VALIDATION] │  ⚠️  Ref2 not found in top 100 results`);
        // If not found, try direct search
        const directRef2 = await qdrantService.searchSimilar(ref2_phrase, qdrantCategory, 1, 0.0);
        if (directRef2 && directRef2.score) {
          new_to_ref2_score = directRef2.score;
          console.log(`[VALIDATION] │  ✓ Got ref2 score via direct search`);
        }
      }
    }
    
    const gold_to_ref2_score = GOLD_TO_REF2_SCORES[qdrantCategory]?.[gold_standard.toLowerCase()] || 0;
    variables.variable4_distance_to_ref2 = Math.abs(new_to_ref2_score - gold_to_ref2_score);
    
    console.log(`[VALIDATION] │  New→Ref2 Score: ${new_to_ref2_score.toFixed(4)}`);
    console.log(`[VALIDATION] │  Gold→Ref2 Score: ${gold_to_ref2_score.toFixed(4)}`);
    console.log(`[VALIDATION] │  Distance: ${variables.variable4_distance_to_ref2.toFixed(4)}`);

    if (variables.variable4_distance_to_ref2 < MAX_DISTANCE_TO_REF2) {
      console.log(`[VALIDATION] └─ ✅ PASSED`);
      console.log(`[VALIDATION] 🎉 ACCEPTED via REF2`);
      console.log(`${'='.repeat(80)}\n`);
      return {
        matched: true, gold_standard, clarity: 'Adequate Clarity',
        variables,
        validation_path: 'REF2'
      };
    }
    console.log(`[VALIDATION] └─ ❌ FAILED`);

    console.log(`[VALIDATION] ❌ ALL CHECKS FAILED`);
    console.log(`${'='.repeat(80)}\n`);
    return { matched: false, gold_standard, clarity: null, variables, validation_path: 'NONE' };
  } catch (error) {
    console.error('[VALIDATION] Error:', error.message);
    console.log(`${'='.repeat(80)}\n`);
    return { matched: false, gold_standard: null, clarity: null, variables: null, validation_path: 'ERROR' };
  }
}

function logValidationSummary(validation_logs) {
  console.log('================================================================================');
  console.log('VALIDATION SUMMARY');
  console.log('================================================================================');
  console.log(`Total Checks: ${validation_logs.length}`);
  console.log(`✅ Accepted: ${validation_logs.filter(log => log.acceptance_status === 'ACCEPTED').length}`);
  console.log(`❌ Rejected: ${validation_logs.filter(log => log.acceptance_status === 'REJECTED').length}`);
  
  if (validation_logs.length > 0) {
    console.log('--- ACCEPTED VALIDATIONS ---');
    validation_logs.forEach((log, index) => {
      if (log.acceptance_status === 'ACCEPTED') {
        console.log(`[${index + 1}] Component: ${log.component_type.toUpperCase()}`);
        console.log(`    New Value: "${log.variable1_new_value}"`);
        console.log(`    Distance to Gold: ${log.variable2_distance_to_gold.toFixed(4)}`);
        console.log(`    Distance to Ref1: ${log.variable3_distance_to_ref1 ? log.variable3_distance_to_ref1.toFixed(4) : 'N/A'}`);
        console.log(`    Distance to Ref2: ${log.variable4_distance_to_ref2 ? log.variable4_distance_to_ref2.toFixed(4) : 'N/A'}`);
        console.log(`    Validation Path: ${log.validation_path}`);
        console.log(`    Status: ✅ ACCEPTED`);
      }
    });
    
    console.log('--- REJECTED VALIDATIONS ---');
    validation_logs.forEach((log, index) => {
      if (log.acceptance_status === 'REJECTED') {
        console.log(`[${index + 1}] Component: ${log.component_type.toUpperCase()}`);
        console.log(`    New Value: "${log.variable1_new_value}"`);
        console.log(`    Distance to Gold: ${log.variable2_distance_to_gold.toFixed(4)}`);
        console.log(`    Distance to Ref1: ${log.variable3_distance_to_ref1 ? log.variable3_distance_to_ref1.toFixed(4) : 'N/A'}`);
        console.log(`    Distance to Ref2: ${log.variable4_distance_to_ref2 ? log.variable4_distance_to_ref2.toFixed(4) : 'N/A'}`);
        console.log(`    Validation Path: ${log.validation_path}`);
        console.log(`    Status: ❌ REJECTED`);
      }
    });
  }
  console.log('================================================================================');
}

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
      proceed_button: false,
      redirect_flag: false,
      redirect_url: '',
      suggested_action: '',
      example_query: '',
      validation_logs: [],
      step1_reply: '',
      step2_reply: '',
      step3_reply: '',
      step4_reply: ''
    };
  }

  async step1_intentConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let intentFound = false;
    console.log(`\n[STEP1] Intent Detection Start`);

    // Check dictionary first
    for (const [intent, patterns] of Object.entries(INTENT_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input.startsWith(keyword.toLowerCase())) {
          this.analysis.intent = { status: 'Clear', value: intent, reply: `Detected intent: ${intent}` };
          this.analysis.step1_reply = `Detected intent: ${intent}`;
          intentFound = true;
          console.log(`[STEP1] ✓ Found in dictionary: "${keyword}" → ${intent}`);
          break;
        }
      }
      if (intentFound) break;
    }

    // Check phrase dictionary
    if (!intentFound) {
      for (const [intent, phrases] of Object.entries(INTENT_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.startsWith(phrase.toLowerCase())) {
            this.analysis.intent = { status: 'Adequate Clarity', value: intent, reply: `Detected intent: ${intent}` };
            this.analysis.step1_reply = `Detected intent: ${intent}`;
            intentFound = true;
            console.log(`[STEP1] ✓ Found in phrase dictionary: "${phrase}" → ${intent}`);
            break;
          }
        }
        if (intentFound) break;
      }
    }

    // Extract and validate with Qdrant
    if (!intentFound) {
      let searchText = extractIntentText(input);
      if (searchText && searchText.trim() !== '') {
        console.log(`[STEP1] Performing validation for: "${searchText}"`);
        const validation_result = await performCircleValidation(searchText, 'intent');
        if (validation_result.matched) {
          const category = INTENT_PHRASE_TO_CATEGORY[validation_result.gold_standard.toLowerCase()] || 'menu';
          this.analysis.intent = { 
            status: validation_result.clarity, 
            value: category, 
            reply: `Detected intent: ${category}` 
          };
          this.analysis.step1_reply = `Detected intent: ${category}`;
          intentFound = true;
          
          if (validation_result.variables) {
            this.analysis.validation_logs.push({ 
              component_type: 'intent', 
              ...validation_result.variables, 
              validation_path: validation_result.validation_path, 
              acceptance_status: 'ACCEPTED' 
            });
          }
        } else if (validation_result.variables) {
          this.analysis.validation_logs.push({ 
            component_type: 'intent', 
            ...validation_result.variables, 
            validation_path: validation_result.validation_path, 
            acceptance_status: 'REJECTED' 
          });
        }
      } else {
        this.analysis.intent = { status: 'Not Found', value: '', reply: 'Unable to determine your intent.' };
        this.analysis.step1_reply = 'Unable to determine your intent.';
      }
    }
    console.log(`[STEP1] Result: ${this.analysis.intent.status} - ${this.analysis.intent.value}`);
  }

  async step2_processConclusion(userInput) {
    const input = userInput.toLowerCase().trim();
    let processFound = false;
    console.log(`\n[STEP2] Process Detection Start`);

    // Check dictionary first
    for (const [process, patterns] of Object.entries(PROCESS_DICTIONARY)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (input === keyword.toLowerCase() || input.includes(keyword.toLowerCase())) {
          this.analysis.process = { status: 'Clear', value: process, reply: `Detected process: ${process}` };
          this.analysis.step2_reply = `Detected process: ${process}`;
          processFound = true;
          console.log(`[STEP2] ✓ Found in dictionary: "${keyword}" → ${process}`);
          break;
        }
      }
      if (processFound) break;
    }

    // Check phrase dictionary
    if (!processFound) {
      for (const [process, phrases] of Object.entries(PROCESS_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.process = { status: 'Adequate Clarity', value: process, reply: `Detected process: ${process}` };
            this.analysis.step2_reply = `Detected process: ${process}`;
            processFound = true;
            console.log(`[STEP2] ✓ Found in phrase dictionary: "${phrase}" → ${process}`);
            break;
          }
        }
        if (processFound) break;
      }
    }

    // Extract and validate with Qdrant
    if (!processFound) {
      let searchText = extractProcessText(input);
      
      console.log(`[STEP2] Extracted process text: "${searchText}"`);
      
      if (searchText && searchText.trim() !== '') {
        console.log(`[STEP2] Performing validation for: "${searchText}"`);
        const validation_result = await performCircleValidation(searchText, 'process');
        
        if (validation_result.matched) {
          this.analysis.process = { 
            status: validation_result.clarity, 
            value: validation_result.gold_standard, 
            reply: `Detected process: ${validation_result.gold_standard}` 
          };
          this.analysis.step2_reply = `Detected process: ${validation_result.gold_standard}`;
          processFound = true;
          
          if (validation_result.variables) {
            this.analysis.validation_logs.push({ 
              component_type: 'process', 
              ...validation_result.variables, 
              validation_path: validation_result.validation_path, 
              acceptance_status: 'ACCEPTED' 
            });
          }
        } else if (validation_result.variables) {
          this.analysis.validation_logs.push({ 
            component_type: 'process', 
            ...validation_result.variables, 
            validation_path: validation_result.validation_path, 
            acceptance_status: 'REJECTED' 
          });
        }
      }
    }

    if (!processFound) {
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
          this.analysis.action = { status: 'Clear', value: action, reply: `Detected action: ${action}` };
          this.analysis.step3_reply = `Detected action: ${action}`;
          actionFound = true;
          console.log(`[STEP3] ✓ Found in dictionary: "${keyword}" → ${action}`);
          break;
        }
      }
      if (actionFound) break;
    }

    if (!actionFound) {
      for (const [action, phrases] of Object.entries(ACTION_PHRASE_DICTIONARY)) {
        for (const phrase of phrases) {
          if (input.includes(phrase.toLowerCase())) {
            this.analysis.action = { status: 'Adequate Clarity', value: action, reply: `Detected action: ${action}` };
            this.analysis.step3_reply = `Detected action: ${action}`;
            actionFound = true;
            console.log(`[STEP3] ✓ Found in phrase dictionary: "${phrase}" → ${action}`);
            break;
          }
        }
        if (actionFound) break;
      }
    }

    if (!actionFound) {
      let searchText = extractActionText(input);
      
      if (!searchText) {
        const actionVerbs = ['create', 'modify', 'update', 'search', 'delete', 'add', 'remove', 'find', 'construct', 'draft'];
        const lowerInput = input.toLowerCase();
        let earliestPosition = -1;
        let foundVerb = '';
        
        for (const verb of actionVerbs) {
          const position = lowerInput.indexOf(verb);
          if (position !== -1) {
            if (earliestPosition === -1 || position < earliestPosition) {
              earliestPosition = position;
              foundVerb = verb;
            }
          }
        }
        
        if (earliestPosition === -1) {
          const intentPhrases = INTENT_DICTIONARY[this.analysis.intent.value]?.primary || [];
          let inputWords = input.split(/\s+/);
          let actionIndex = inputWords.findIndex(word => intentPhrases.some(phrase => phrase.split(/\s+/).includes(word))) + 1;
          searchText = inputWords[actionIndex] || '';
        } else {
          const afterVerbPosition = earliestPosition + foundVerb.length;
          const afterVerb = input.substring(afterVerbPosition).trim();
          const words = afterVerb.split(/\s+/);
          if (words.length > 0 && words[0]) {
            searchText = words[0];
          }
        }
      }
      
      if (searchText) {
        console.log(`[STEP3] Performing validation for: "${searchText}"`);
        const validation_result = await performCircleValidation(searchText, 'action');
        if (validation_result.matched) {
          this.analysis.action = { status: validation_result.clarity, value: validation_result.gold_standard, reply: `Detected action: ${validation_result.gold_standard}` };
          this.analysis.step3_reply = `Detected action: ${validation_result.gold_standard}`;
          actionFound = true;
          if (validation_result.variables) {
            this.analysis.validation_logs.push({ component_type: 'action', ...validation_result.variables, validation_path: validation_result.validation_path, acceptance_status: 'ACCEPTED' });
          }
        } else if (validation_result.variables) {
          this.analysis.validation_logs.push({ component_type: 'action', ...validation_result.variables, validation_path: validation_result.validation_path, acceptance_status: 'REJECTED' });
        }
      }
    }

    if (!actionFound) {
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
      this.analysis.filters = { status: 'Not Applicable', value: [], reply: 'Filters not applicable.' };
      this.analysis.step4_reply = 'Filters not applicable.';
      console.log(`[STEP4] Filters not applicable for intent: ${intentCategory}, action: ${actionValue}`);
      return;
    }

    let filter_input = input;
    const where_index = input.indexOf('where');
    if (where_index !== -1) {
      filter_input = input.substring(where_index + 5).trim();
    }

    const detectedFilters = [];
    const filterSet = new Set(); // To track unique filter combinations
    for (const pattern of FILTER_PATTERNS) {
      let match;
      while ((match = pattern.exec(filter_input)) !== null) {
        const filterName = match[1] ? match[1].trim() : match[4] ? match[4].trim() : '';
        const operator = match[2] ? match[2].trim() : match[5] ? match[5].trim() : '=';
        const value = match[3] ? match[3].trim() : match[6] ? match[6].trim() : '';
        if (filterName && value) {
          const filterKey = `${filterName}_${operator}_${value}`; // Unique key for deduplication
          if (!filterSet.has(filterKey)) {
            detectedFilters.push({
              name: filterName.toLowerCase(), operator: operator.toLowerCase(), value: value.toLowerCase(),
              name_status: 'Not Found', operator_status: 'Not Found', value_status: 'Not Found'
            });
            filterSet.add(filterKey);
          }
        }
      }
    }

    if (detectedFilters.length === 0) {
      this.analysis.filters = { status: 'Not Found', value: [], reply: 'No filters detected.' };
      this.analysis.step4_reply = 'No filters detected.';
      console.log(`[STEP4] No filters detected in input`);
      return;
    }

    console.log(`[STEP4] Found ${detectedFilters.length} filter(s)`);
    for (let i = 0; i < detectedFilters.length; i++) {
      const filter = detectedFilters[i];
      console.log(`[STEP4] Analyzing filter ${i + 1}: name="${filter.name}", operator="${filter.operator}", value="${filter.value}"`);
      await this.analyzeFilterComponent(filter, 'name', 'filter_name', FILTER_NAME_DICTIONARY, FILTER_NAME_PHRASE_DICTIONARY);
      await this.analyzeFilterComponent(filter, 'operator', 'filter_operator', FILTER_OPERATOR_DICTIONARY, FILTER_OPERATOR_PHRASE_DICTIONARY);
      await this.analyzeFilterComponent(filter, 'value', 'filter_value', FILTER_VALUE_DICTIONARY, FILTER_VALUE_PHRASE_DICTIONARY);
    }

    this.analysis.filters.value = detectedFilters;
    const allClear = detectedFilters.every(f => f.name_status === 'Clear' && f.operator_status === 'Clear' && f.value_status === 'Clear');
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
    console.log(`[STEP4] Result: ${this.analysis.filters.status}`);
  }

  async analyzeFilterComponent(filter, componentKey, category, dictionary, phraseDictionary) {
    const componentValue = filter[componentKey];
    const statusKey = `${componentKey}_status`;
    let found = false;

    for (const [standardValue, patterns] of Object.entries(dictionary)) {
      for (const keyword of [...patterns.primary, ...patterns.synonyms]) {
        if (componentValue === keyword.toLowerCase() || componentValue.includes(keyword.toLowerCase())) {
          filter[statusKey] = 'Clear';
          filter[componentKey] = standardValue;
          found = true;
          console.log(`[STEP4] ✓ Filter ${componentKey} found in dictionary: "${keyword}" → ${standardValue}`);
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
            console.log(`[STEP4] ✓ Filter ${componentKey} found in phrase dictionary: "${phrase}" → ${standardValue}`);
            break;
          }
        }
        if (found) break;
      }
    }

    if (!found) {
      console.log(`[STEP4] Performing validation for filter ${componentKey}: "${componentValue}"`);
      const validation_result = await performCircleValidation(componentValue, category);
      if (validation_result.matched) {
        filter[statusKey] = validation_result.clarity;
        filter[componentKey] = validation_result.gold_standard;
        found = true;
        if (validation_result.variables) {
          this.analysis.validation_logs.push({
            component_type: category, ...validation_result.variables,
            validation_path: validation_result.validation_path, acceptance_status: 'ACCEPTED'
          });
        }
      } else if (validation_result.variables) {
        this.analysis.validation_logs.push({
          component_type: category, ...validation_result.variables,
          validation_path: validation_result.validation_path, acceptance_status: 'REJECTED'
        });
      }
    }

    if (!found) {
      filter[statusKey] = 'Not Clear';
      console.log(`[STEP4] ✗ Filter ${componentKey} not clear: "${componentValue}"`);
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

    const allValid = 
      (intentStatus === 'Clear' || intentStatus === 'Adequate Clarity') &&
      (processStatus === 'Clear' || processStatus === 'Adequate Clarity') &&
      (actionStatus === 'Clear' || actionStatus === 'Adequate Clarity') &&
      (filterStatus === 'Clear' || filterStatus === 'Adequate Clarity' || filterStatus === 'Not Applicable' || filterStatus === 'Not Found');

    if (allValid) {
      let filterText = '';
      if (filterStatus === 'Clear' || filterStatus === 'Adequate Clarity') {
        const filterDescriptions = this.analysis.filters.value.map(f => `${f.name} ${f.operator} ${f.value}`).join(', ');
        filterText = ` with filters: ${filterDescriptions}`;
      }
      this.analysis.finalAnalysis = `Your intent is clear to ${actionValue} on ${processValue}${filterText}.`;
      this.analysis.proceed_button = true;
      console.log(`[STEP5] ✅ Analysis successful`);
    } else {
      let failures = [];
      if (intentStatus !== 'Clear' && intentStatus !== 'Adequate Clarity') failures.push('intent');
      if (processStatus !== 'Clear' && processStatus !== 'Adequate Clarity') failures.push('process');
      if (actionStatus !== 'Clear' && actionStatus !== 'Adequate Clarity') failures.push('action');
      if (filterStatus === 'Not Clear') failures.push('filters');
      this.analysis.finalAnalysis = `Unable to determine: ${failures.join(', ')}.`;
      this.analysis.proceed_button = false;
      console.log(`[STEP5] ❌ Analysis incomplete - failures: ${failures.join(', ')}`);

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
  }

  async analyze(userInput) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`NEW ANALYSIS REQUEST: "${userInput}"`);
    console.log(`${'='.repeat(80)}`);
    
    this.reset();
    this.analysis.userInput = userInput;
    
    await this.step1_intentConclusion(userInput);
    await this.step2_processConclusion(userInput);
    
    if (this.checkHelpRedirect()) {
      logValidationSummary(this.analysis.validation_logs);
      console.log(`${'='.repeat(80)}\n`);
      return this.analysis;
    }
    
    await this.step3_actionConclusion(userInput);
    await this.step4_filterAnalysis(userInput);
    this.step5_finalAnalysis();
    
    logValidationSummary(this.analysis.validation_logs);
    
    console.log(`${'='.repeat(80)}\n`);
    return this.analysis;
  }
}

app.use((req, res, next) => {
  console.log(`📋 ${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', timestamp: new Date().toISOString(),
    qdrant_initialized: qdrantService.initialized, port: PORT, uptime: process.uptime()
  });
});

app.get('/qdrant-status', async (req, res) => {
  try {
    const info = await qdrantService.getCollectionInfo();
    res.json({
      success: true, initialized: qdrantService.initialized, collection_exists: info !== null, collection_info: info,
      environment: { qdrant_url_set: !!process.env.QDRANT_URL, qdrant_api_key_set: !!process.env.QDRANT_API_KEY, qdrant_url: process.env.QDRANT_URL || 'NOT SET' }
    });
  } catch (error) {
    res.status(500).json({
      success: false, error: error.message, initialized: qdrantService.initialized,
      environment: { qdrant_url_set: !!process.env.QDRANT_URL, qdrant_api_key_set: !!process.env.QDRANT_API_KEY }
    });
  }
});

// Testing endpoint to search Qdrant
app.post('/api/search-test', async (req, res) => {
  try {
    const { text, category, limit } = req.body;
    
    if (!text || !category) {
      return res.status(400).json({ 
        success: false, 
        error: 'text and category are required' 
      });
    }
    
    const results = await qdrantService.searchSimilar(
      text, 
      category, 
      limit || 50, 
      0.0
    );
    
    res.json({ 
      success: true, 
      search_text: text,
      category: category,
      results: results
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.post('/analyze', async (req, res) => {
  try {
    const { sentence } = req.body;
    if (!sentence || sentence.trim() === '') {
      return res.status(400).json({ success: false, error: 'Sentence is required' });
    }
    if (!qdrantService.initialized) {
      return res.status(503).json({ success: false, error: 'Service initializing. Please try again.' });
    }
    
    const analyzer = new ConversationAnalyzer();
    const analysis = await analyzer.analyze(sentence);
    
    const logEntry = { 
      timestamp: new Date().toISOString(), 
      sentence, 
      analysis,
      validation_logs: analysis.validation_logs 
    };
    
    logs.push(logEntry);
    if (logs.length > 100) logs.shift();
    
    const validationSummary = {
      total_checks: analysis.validation_logs.length,
      accepted: analysis.validation_logs.filter(log => log.acceptance_status === 'ACCEPTED').length,
      rejected: analysis.validation_logs.filter(log => log.acceptance_status === 'REJECTED').length,
      details: analysis.validation_logs
    };
    
    res.json({ 
      success: true, 
      analysis,
      validation_summary: validationSummary
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: 'Analysis failed', message: error.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    const { sentence } = req.body;
    if (!sentence || sentence.trim() === '') {
      return res.status(400).json({ success: false, error: 'Sentence is required' });
    }
    if (!qdrantService.initialized) {
      return res.status(503).json({ success: false, error: 'Service initializing. Please try again.' });
    }
    
    const analyzer = new ConversationAnalyzer();
    const analysis = await analyzer.analyze(sentence);
    
    const logEntry = { 
      timestamp: new Date().toISOString(), 
      sentence, 
      analysis,
      validation_logs: analysis.validation_logs 
    };
    
    logs.push(logEntry);
    if (logs.length > 100) logs.shift();
    
    const validationSummary = {
      total_checks: analysis.validation_logs.length,
      accepted: analysis.validation_logs.filter(log => log.acceptance_status === 'ACCEPTED').length,
      rejected: analysis.validation_logs.filter(log => log.acceptance_status === 'REJECTED').length,
      details: analysis.validation_logs
    };
    
    res.json({ 
      success: true, 
      analysis,
      validation_summary: validationSummary
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ success: false, error: 'Analysis failed', message: error.message });
  }
});

app.get('/api/logs', (req, res) => {
  res.json({ success: true, logs });
});

app.post('/api/logs/clear', (req, res) => {
  logs.length = 0;
  res.json({ success: true, message: 'Logs cleared' });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
});

app.listen(PORT, async () => {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`SERVER STARTING`);
  console.log(`Port: ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`${'='.repeat(80)}`);
  
  try {
    console.log('Initializing Qdrant service...');
    await qdrantService.initialize();
    console.log('✓ Qdrant initialized');
    console.log(`\nVALIDATION CONFIG (FROM PSEUDOCODE):`);
    console.log(`  Safety Floor: ${SAFETY_FLOOR}`);
    console.log(`  Max Distance Gold: ${MAX_DISTANCE_TO_GOLD}`);
    console.log(`  Max Distance Ref1: ${MAX_DISTANCE_TO_REF1}`);
    console.log(`  Max Distance Ref2: ${MAX_DISTANCE_TO_REF2}`);
    console.log(`\n🚀 Server ready on port ${PORT}`);
    console.log(`${'='.repeat(80)}\n`);
  } catch (error) {
    console.error('❌ Qdrant init failed:', error.message);
    console.log('⚠️ Server running without Qdrant');
  }
});