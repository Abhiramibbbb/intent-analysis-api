$(document).ready(function() {
    'use strict';

    // Global variables
    let isAnalyzing = false;
    let currentAnalysis = null;

    // Initialize the application
    initializeApp();

    function initializeApp() {
        console.log('Initializing Conversational UI Application...');
        
        // Load initial conversation logs
        loadConversationLogs();
        
        // Set focus on input field
        $('#userInput').focus();
        
        // Initialize character counter
        updateCharacterCounter();
        
        console.log('Application initialized successfully');
    }

    // Event Handlers
    $('#userInput').on('input', function() {
        updateCharacterCounter();
        
        // Clear previous analysis when user types
        if (currentAnalysis && $(this).val().trim() !== currentAnalysis.userInput) {
            clearAnalysisOutput();
        }
    });

    $('#userInput').on('keypress', function(e) {
        if (e.which === 13 && !e.shiftKey) { // Enter key
            e.preventDefault();
            if (!isAnalyzing) {
                performAnalysis();
            }
        }
    });

    $('#analyzeBtn').click(function() {
        if (!isAnalyzing) {
            performAnalysis();
        }
    });

    $('#proceedBtn').click(function() {
        if (currentAnalysis && currentAnalysis.proceed_button) {
            handleProceedAction();
        }
    });

    $('#clearBtn').click(function() {
        clearAll();
    });

    $('#refreshLogsBtn').click(function() {
        loadConversationLogs();
    });

    // Update character counter
    function updateCharacterCounter() {
        const input = $('#userInput');
        const currentLength = input.val().length;
        const maxLength = input.attr('maxlength');
        const counter = $('.char-counter');
        
        counter.text(`${currentLength}/${maxLength}`);
        
        if (currentLength > maxLength * 0.9) {
            counter.css('color', '#dc3545'); // Red warning
        } else if (currentLength > maxLength * 0.75) {
            counter.css('color', '#ffc107'); // Yellow warning
        } else {
            counter.css('color', '#6c757d'); // Normal gray
        }
    }

    // Main analysis function
    function performAnalysis() {
        const userInput = $('#userInput').val().trim();
        
        if (!userInput) {
            showMessage('Please enter a sentence to analyze.', 'error');
            $('#userInput').focus();
            return;
        }
        
        if (userInput.length > 500) {
            showMessage('Sentence is too long. Please keep it under 500 characters.', 'error');
            return;
        }

        console.log('Starting analysis for:', userInput);
        
        setAnalyzingState(true);
        
        // Make AJAX request to server
        $.ajax({
            url: '/analyze',
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ sentence: userInput }),
            timeout: 0, // No timeout
            success: function(response) {
                console.log('Analysis completed:', response);
                currentAnalysis = {
                    userInput: userInput,
                    ...response
                };
                displayAnalysisResults(response);
                loadConversationLogs(); // Refresh logs
                showMessage('Analysis completed successfully!', 'success');
            },
            error: function(xhr, status, error) {
                console.error('Analysis failed:', { status, error, xhrStatus: xhr.status, response: xhr.responseJSON });
                let errorMessage = 'Failed to analyze the sentence. ';
                
                if (xhr.status === 0) {
                    errorMessage += 'Connection lost. Ensure the server is running and accessible.';
                } else if (xhr.responseJSON && xhr.responseJSON.error) {
                    errorMessage += xhr.responseJSON.error;
                } else if (xhr.status >= 500) {
                    errorMessage += 'Server error occurred. Please try again later.';
                } else {
                    errorMessage += 'An unexpected error occurred. Please try again.';
                }
                
                showMessage(errorMessage, 'error');
                clearAnalysisOutput();
            },
            complete: function() {
                setAnalyzingState(false);
            }
        });
    }

    // Display analysis results
    function displayAnalysisResults(response) {
        const outputSection = $('#outputSection');
        const analysisOutput = $('#analysisOutput');
        const suggestionsSection = $('#suggestionsSection');
        const suggestedAction = $('#suggestedAction');
        const exampleQuery = $('#exampleQuery');
        const proceedBtn = $('#proceedBtn');
        
        // Show output section
        outputSection.show();
        
        // Display analysis_reply
        analysisOutput.html(response.analysis_reply);
        
        // Style the output based on content
        analysisOutput.removeClass('success warning error');
        if (response.analysis_reply.toLowerCase().includes('your intent is clear')) {
            analysisOutput.addClass('success');
        } else if (response.analysis_reply.toLowerCase().includes('unable to determine')) {
            analysisOutput.addClass('error');
        } else {
            analysisOutput.addClass('warning');
        }
        
        // Enable/disable proceed button
        proceedBtn.prop('disabled', !response.proceed_button);
        
        if (response.proceed_button) {
            proceedBtn.removeClass('btn-secondary').addClass('btn-success');
        } else {
            proceedBtn.removeClass('btn-success').addClass('btn-secondary');
        }
        
        // Display suggestions if available
        if (response.suggested_action || response.example_query) {
            suggestionsSection.show();
            
            if (response.suggested_action) {
                suggestedAction.html(`<strong>💡 Suggested Action:</strong> ${response.suggested_action}`);
                suggestedAction.show();
            } else {
                suggestedAction.hide();
            }
            
            if (response.example_query) {
                exampleQuery.html(`<strong>Example:</strong> "${response.example_query}"`);
                exampleQuery.show();
            } else {
                exampleQuery.hide();
            }
        } else {
            suggestionsSection.hide();
        }
        
        // Scroll to results
        outputSection[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
        
        console.log('Analysis results displayed successfully:', response);
    }

    // Handle proceed action
    function handleProceedAction() {
        if (!currentAnalysis) {
            showMessage('No analysis available to proceed with.', 'error');
            return;
        }
        
        // Show confirmation
        const confirmMessage = `Are you sure you want to proceed with the detected intent?\n\nAnalysis: ${currentAnalysis.analysis_reply}`;
        
        if (confirm(confirmMessage)) {
            showMessage('Action executed successfully! (This is a simulation)', 'success');
            console.log('Proceed action executed for analysis:', currentAnalysis);
        }
    }

    // Load conversation logs from server
    function loadConversationLogs() {
        console.log('Loading conversation logs...');
        
        $.ajax({
            url: '/logs',
            method: 'GET',
            success: function(logs) {
                displayConversationLogs(logs);
                console.log('Conversation logs loaded successfully:', logs);
            },
            error: function(xhr, status, error) {
                console.error('Failed to load logs:', { status, error, xhrStatus: xhr.status });
                showMessage('Failed to load conversation logs. Please try again.', 'error');
            }
        });
    }

    // Display conversation logs in table format
    function displayConversationLogs(logs) {
        const logsContainer = $('#logsContainer');
        
        if (!logs || logs.length === 0) {
            logsContainer.html(`
                <div class="no-logs">
                    <p>📝 No conversations logged yet. Start by entering a sentence above!</p>
                </div>
            `);
            return;
        }
        
        // Create table structure
        let tableHtml = `
            <table class="logs-table">
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>Intent</th>
                        <th>Process</th>
                        <th>Action</th>
                        <th>Filters</th>
                        <th>Final Analysis</th>
                        <th>Suggested Action</th>
                        <th>Example Query</th>
                        <th>Proceed</th>
                        <th>Timestamp</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        logs.forEach(function(log) {
            const timestamp = new Date(log.Timestamp).toLocaleString();
            const finalAnalysis = truncateText(log.Final_Analysis_Response_Status, 50);
            const suggestedAction = truncateText(log.Suggested_Action || '', 30);
            const exampleQuery = truncateText(log.Example_Query || '', 25);
            
            tableHtml += `
                <tr>
                    <td>${log.Sentence_ID}</td>
                    <td class="${getStatusClass(log.Intent)}">${log.Intent}</td>
                    <td class="${getStatusClass(log.Process)}">${log.Process}</td>
                    <td class="${getStatusClass(log.Action)}">${log.Action}</td>
                    <td class="${getStatusClass(log.Filters)}">${log.Filters}</td>
                    <td title="${escapeHtml(log.Final_Analysis_Response_Status)}">${finalAnalysis}</td>
                    <td title="${escapeHtml(log.Suggested_Action || '')}">${suggestedAction}</td>
                    <td title="${escapeHtml(log.Example_Query || '')}">${exampleQuery}</td>
                    <td class="${getProceedClass(log.Proceed_Button_Status)}">${log.Proceed_Button_Status}</td>
                    <td>${timestamp}</td>
                </tr>
            `;
        });
        
        tableHtml += '</tbody></table>';
        logsContainer.html(tableHtml);
    }

    // Helper functions
    function getStatusClass(status) {
        if (!status) return 'status-not-found';
        
        switch (status.toLowerCase()) {
            case 'clear':
                return 'status-clear';
            case 'adequate clarity':
                return 'status-adequate';
            case 'not clear':
                return 'status-not-clear';
            case 'not found':
                return 'status-not-found';
            default:
                return '';
        }
    }

    function getProceedClass(status) {
        return status === 'Yes' ? 'proceed-yes' : 'proceed-no';
    }

    function truncateText(text, maxLength) {
        if (!text) return '';
        return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
    }

    function escapeHtml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Set analyzing state
    function setAnalyzingState(analyzing) {
        isAnalyzing = analyzing;
        
        const analyzeBtn = $('#analyzeBtn');
        const userInput = $('#userInput');
        const loadingIndicator = $('#loadingIndicator');
        
        if (analyzing) {
            analyzeBtn.prop('disabled', true).html('<span class="btn-icon">⏳</span> Analyzing...');
            userInput.prop('disabled', true);
            loadingIndicator.show();
        } else {
            analyzeBtn.prop('disabled', false).html('<span class="btn-icon">🔍</span> Analyze');
            userInput.prop('disabled', false);
            loadingIndicator.hide();
        }
    }

    // Clear analysis output
    function clearAnalysisOutput() {
        $('#outputSection').hide();
        $('#analysisOutput').empty();
        $('#suggestionsSection').hide();
        $('#proceedBtn').prop('disabled', true).removeClass('btn-success').addClass('btn-secondary');
        currentAnalysis = null;
    }

    // Clear all inputs and outputs
    function clearAll() {
        $('#userInput').val('');
        updateCharacterCounter();
        clearAnalysisOutput();
        $('#userInput').focus();
        console.log('All inputs and outputs cleared');
    }

    // Show message to user
    function showMessage(message, type) {
        const messageContainer = $('#messageContainer');
        const messageId = 'msg_' + Date.now();
        
        const messageHtml = `
            <div id="${messageId}" class="message message-${type}">
                <span class="message-icon">${getMessageIcon(type)}</span>
                <span class="message-text">${escapeHtml(message)}</span>
                <button class="message-close" onclick="closeMessage('${messageId}')">&times;</button>
            </div>
        `;
        
        messageContainer.append(messageHtml);
        
        // Auto-remove message after 5 seconds
        setTimeout(function() {
            $(`#${messageId}`).fadeOut(300, function() {
                $(this).remove();
            });
        }, 5000);
    }

    // Get message icon based on type
    function getMessageIcon(type) {
        switch (type) {
            case 'success': return '✅';
            case 'error': return '❌';
            case 'info': return 'ℹ️';
            default: return '🔔';
        }
    }

    // Global function to close message
    window.closeMessage = function(messageId) {
        $(`#${messageId}`).fadeOut(300, function() {
            $(this).remove();
        });
    };

    // Keyboard shortcuts
    $(document).on('keydown', function(e) {
        // Ctrl+Enter or Cmd+Enter to analyze
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            if (!isAnalyzing) {
                performAnalysis();
            }
            e.preventDefault();
        }
        
        // Escape to clear
        if (e.key === 'Escape') {
            clearAll();
            e.preventDefault();
        }
        
        // Ctrl+R or Cmd+R to refresh logs
        if ((e.ctrlKey || e.metaKey) && e.key === 'r') {
            loadConversationLogs();
            e.preventDefault();
        }
    });

    // Handle connection errors
    $(document).ajaxError(function(event, xhr, settings, error) {
        console.error('Global AJAX error:', { url: settings.url, status: xhr.status, error });
        if (xhr.status === 0) {
            showMessage('Connection lost. Ensure the server is running and accessible.', 'error');
        } else if (xhr.status >= 500) {
            showMessage('Server error occurred. Please try again later.', 'error');
        }
    });

    // Log application events for debugging
    window.addEventListener('error', function(e) {
        console.error('JavaScript error:', e.error);
        showMessage('An unexpected error occurred. Please refresh the page.', 'error');
    });

    console.log('jQuery application script loaded successfully');
});