const sentenceInput = document.getElementById('sentenceInput');
const charCount = document.getElementById('charCount');
const analyzeBtn = document.getElementById('analyzeBtn');
const proceedBtn = document.getElementById('proceedBtn');
const clearBtn = document.getElementById('clearBtn');
const analysisResult = document.getElementById('analysisResult');
const refreshBtn = document.getElementById('refreshBtn');
const logsTableBody = document.getElementById('logsTableBody');

// Character counter
sentenceInput.addEventListener('input', () => {
    charCount.textContent = sentenceInput.value.length;
});

// Analyze button
analyzeBtn.addEventListener('click', async () => {
    const sentence = sentenceInput.value.trim();
    if (!sentence) {
        alert('Please enter a sentence to analyze');
        return;
    }

    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing...';
    proceedBtn.disabled = true;

    try {
        const response = await fetch('/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sentence })
        });

        const data = await response.json();

        // Check for redirect
        if (data.redirect_flag && data.redirect_url) {
            window.location.href = data.redirect_url;
            return;
        }

        // Display result
        analysisResult.style.display = 'block';
        analysisResult.innerHTML = `
            <div class="result-box">
                <h5><i class="fas fa-chart-bar"></i> Analysis Result</h5>
                <div class="alert ${data.proceed_button ? 'alert-success' : 'alert-warning'}">
                    ${data.analysis_reply}
                </div>
                ${data.suggested_action ? `<p class="mb-2"><strong><i class="fas fa-lightbulb"></i> Suggestion:</strong> ${data.suggested_action}</p>` : ''}
                ${data.example_query ? `<p class="mb-0"><strong><i class="fas fa-quote-right"></i> Example:</strong> "${data.example_query}"</p>` : ''}
            </div>
        `;

        // Enable/disable proceed button
        proceedBtn.disabled = !data.proceed_button;
        
        loadLogs();
    } catch (error) {
        console.error('Error:', error);
        analysisResult.style.display = 'block';
        analysisResult.innerHTML = `
            <div class="result-box">
                <div class="alert alert-danger">
                    <i class="fas fa-exclamation-triangle"></i> Error analyzing sentence. Please try again.
                </div>
            </div>
        `;
        proceedBtn.disabled = true;
    } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.innerHTML = '<i class="fas fa-search"></i> Analyze Intent';
    }
});

// Clear button
clearBtn.addEventListener('click', () => {
    sentenceInput.value = '';
    charCount.textContent = '0';
    analysisResult.style.display = 'none';
    proceedBtn.disabled = true;
});

// Proceed button
proceedBtn.addEventListener('click', () => {
    alert('Proceeding with the action...');
    // Add your proceed logic here
});

// Refresh logs button
refreshBtn.addEventListener('click', loadLogs);

// Load logs function
async function loadLogs() {
    try {
        const response = await fetch('/logs');
        const logs = await response.json();

        if (logs.length === 0) {
            logsTableBody.innerHTML = '<tr><td colspan="10" class="text-center py-4">No analysis history available</td></tr>';
            return;
        }

        logsTableBody.innerHTML = logs.reverse().map(log => `
            <tr>
                <td>${log.Sentence_ID}</td>
                <td class="${getStatusClass(log.Intent)}">${log.Intent}</td>
                <td class="${getStatusClass(log.Process)}">${log.Process}</td>
                <td class="${getStatusClass(log.Action)}">${log.Action}</td>
                <td>${log.Filters}</td>
                <td>${log.Final_Analysis_Response_Status}</td>
                <td>${log.Suggested_Action || '-'}</td>
                <td>${log.Example_Query || '-'}</td>
                <td><span class="badge ${log.Proceed_Button_Status === 'Yes' ? 'bg-success' : 'bg-secondary'}">${log.Proceed_Button_Status}</span></td>
                <td>${new Date(log.Timestamp).toLocaleString()}</td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error loading logs:', error);
    }
}

function getStatusClass(status) {
    if (status === 'Clear') return 'status-clear';
    if (status === 'Adequate Clarity') return 'status-adequate';
    if (status === 'Not Clear') return 'status-not-clear';
    return 'status-not-found';
}

// Load logs on page load
loadLogs();
