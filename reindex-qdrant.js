const qdrantService = require('./qdrant-service');

// Import dictionaries
const INTENT_DICTIONARY = {
    'menu': {
        primary: ['i would like to'],
        synonyms: ['i need to', 'i want to', 'i wish to']
    },
    'help': {
        primary: ['how do i'],
        synonyms: ['show me how', 'how to']
    }
};

const ACTION_DICTIONARY = {
    'create': {
        primary: ['create', 'add'],
        synonyms: ['enter', 'generate', 'include', 'attach', 'insert']
    },
    'modify': {
        primary: ['modify', 'update'],
        synonyms: ['change', 'edit']
    },
    'search for': {
        primary: ['search for', 'search'],
        synonyms: ['retrieve', 'check']
    },
    'delete record': {
        primary: ['delete record', 'delete'],
        synonyms: ['remove', 'discard']
    }
};

const PROCESS_DICTIONARY = {
    'objective': {
        primary: ['objective'],
        synonyms: ['goal']
    },
    'Key Result': {
        primary: ['Key Result'],
        synonyms: ['KPI']
    },
    'Initiative': {
        primary: ['Initiative'],
        synonyms: ['Action Item']
    },
    'Review Meeting': {
        primary: ['Review Meeting'],
        synonyms: ['Meeting']
    },
    'Key Result Checkin': {
        primary: ['Key Result Checkin'],
        synonyms: ['Checkin']
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
    'equals': { primary: ['=', 'equals', 'is'], synonyms: ['equal to'] },
    'greater than': { primary: ['>', 'greater than'], synonyms: ['more than'] },
    'less than': { primary: ['<', 'less than'], synonyms: ['below'] }
};

const FILTER_VALUE_DICTIONARY = {
    'date': { primary: ['today', 'tomorrow', 'yesterday'], synonyms: [] },
    'priority': { primary: ['high', 'low', 'medium'], synonyms: [] },
    'status': { primary: ['pending', 'completed'], synonyms: ['done'] },
    'quarter': { primary: ['q1', 'q2', 'q3', 'q4', 'quarter 1', 'quarter 2', 'quarter 3', 'quarter 4', '1', '2', '3', '4'], synonyms: [] }
};

const INTENT_PHRASE_DICTIONARY = {
    'menu': ['looking to manage', 'trying to access', 'planning to work on'],
    'help': ['can you explain', 'need assistance with', 'how can i']
};

const ACTION_PHRASE_DICTIONARY = {
    'create': ['set up a new', 'make a new', 'start a'],
    'modify': ['adjust the', 'revise the', 'alter the'],
    'search for': ['look for', 'find the', 'query for'],
    'delete record': ['get rid of', 'remove the', 'erase the']
};

const PROCESS_PHRASE_DICTIONARY = {
    'objective': ['target to achieve', 'plan for', 'aim to complete'],
    'Key Result': ['performance metric', 'result to track', 'key performance indicator'],
    'Initiative': ['project to start', 'task to undertake', 'action to take'],
    'Review Meeting': ['team meeting', 'discussion session', 'review session'],
    'Key Result Checkin': ['progress check', 'status update', 'check-in meeting']
};

const FILTER_NAME_PHRASE_DICTIONARY = {
    'due': ['when it is due', 'due by', 'completion date'],
    'priority': ['level of urgency', 'importance level', 'priority of'],
    'status': ['current state', 'progress status', 'condition of'],
    'assigned': ['who is responsible', 'assigned person', 'task owner']
};

const FILTER_OPERATOR_PHRASE_DICTIONARY = {
    'equals': ['same as', 'matches', 'is exactly'],
    'greater than': ['exceeds', 'higher than', 'above'],
    'less than': ['under', 'lower than', 'lesser than']
};

const FILTER_VALUE_PHRASE_DICTIONARY = {
    'date': ['this week', 'next week', 'last week'],
    'priority': ['urgent', 'normal', 'minor'],
    'status': ['in progress', 'open', 'closed']
};

async function reindex() {
    try {
        console.log('Starting reindexing process...');
        
        // Initialize Qdrant service
        await qdrantService.initialize();
        
        // Clear existing collection
        console.log('Clearing existing collection...');
        await qdrantService.clearCollection();
        
        // Index all dictionaries
        console.log('Indexing dictionaries...');
        await qdrantService.indexDictionaries({
            intent: INTENT_DICTIONARY,
            intentPhrases: INTENT_PHRASE_DICTIONARY,
            action: ACTION_DICTIONARY,
            actionPhrases: ACTION_PHRASE_DICTIONARY,
            process: PROCESS_DICTIONARY,
            processPhrases: PROCESS_PHRASE_DICTIONARY,
            filterName: FILTER_NAME_DICTIONARY,
            filterNamePhrases: FILTER_NAME_PHRASE_DICTIONARY,
            filterOperator: FILTER_OPERATOR_DICTIONARY,
            filterOperatorPhrases: FILTER_OPERATOR_PHRASE_DICTIONARY,
            filterValue: FILTER_VALUE_DICTIONARY,
            filterValuePhrases: FILTER_VALUE_PHRASE_DICTIONARY
        });
        
        // Get collection info
        const info = await qdrantService.getCollectionInfo();
        console.log('\n✓ Reindexing complete!');
        console.log(`Total points indexed: ${info.points_count}`);
        
        process.exit(0);
    } catch (error) {
        console.error('Reindexing failed:', error);
        process.exit(1);
    }
}

reindex();