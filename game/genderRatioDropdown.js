/*
 * Gender Ratio Dropdown Management
 * Handles the "Enforce Gender Ratio" dropdown on teamRosterScreen
 */

const GENDER_RATIO_STORAGE_KEY = 'enforceGenderRatio';

/**
 * Generate all possible gender ratios for a given number of players
 * Returns array of objects with {value, label}
 * Excludes 0:N and N:0 ratios
 */
function generateGenderRatioOptions(playerCount) {
    const options = [];
    
    // Always include "No" option
    options.push({ value: 'No', label: 'No' });
    
    // Add "Alternating" option only for 5 or 7 players
    if (playerCount === 5) {
        options.push({ value: 'Alternating', label: 'Alternating (3:2 / 2:3)' });
    } else if (playerCount === 7) {
        options.push({ value: 'Alternating', label: 'Alternating (4:3 / 3:4)' });
    }
    
    // Add fixed ratio options (excluding 0:N and N:0)
    for (let fmpCount = 1; fmpCount < playerCount; fmpCount++) {
        const mmpCount = playerCount - fmpCount;
        options.push({
            value: `${fmpCount}:${mmpCount}`,
            label: `${fmpCount}:${mmpCount} FMP:MMP`
        });
    }
    
    return options;
}

/**
 * Populate the gender ratio dropdown based on current "Players on Field" value
 */
function populateGenderRatioDropdown() {
    const dropdown = document.getElementById('enforceGenderRatioSelect');
    if (!dropdown) return;
    
    const playersOnFieldInput = document.getElementById('playersOnFieldInput');
    const playerCount = playersOnFieldInput ? parseInt(playersOnFieldInput.value, 10) : 7;
    
    // Clear existing options
    dropdown.innerHTML = '';
    
    // Generate and add options
    const options = generateGenderRatioOptions(playerCount);
    options.forEach(option => {
        const optionElement = document.createElement('option');
        optionElement.value = option.value;
        optionElement.textContent = option.label;
        dropdown.appendChild(optionElement);
    });
    
    // Restore saved selection, or default to "No"
    const savedValue = localStorage.getItem(GENDER_RATIO_STORAGE_KEY);
    if (savedValue && options.some(opt => opt.value === savedValue)) {
        dropdown.value = savedValue;
    } else {
        dropdown.value = 'No';
        localStorage.setItem(GENDER_RATIO_STORAGE_KEY, 'No');
    }
}

// Track if listeners have been initialized to avoid duplicates
let dropdownInitialized = false;

/**
 * Initialize gender ratio dropdown
 * Should be called when teamRosterScreen is shown and when playersOnFieldInput changes
 */
function initializeGenderRatioDropdown() {
    populateGenderRatioDropdown();
    
    // Set up event listeners only once
    if (!dropdownInitialized) {
        // Save selection to localStorage when it changes
        const dropdown = document.getElementById('enforceGenderRatioSelect');
        if (dropdown) {
            dropdown.addEventListener('change', function() {
                localStorage.setItem(GENDER_RATIO_STORAGE_KEY, this.value);
            });
        }
        
        // Repopulate when playersOnFieldInput changes
        const playersOnFieldInput = document.getElementById('playersOnFieldInput');
        if (playersOnFieldInput) {
            playersOnFieldInput.addEventListener('input', populateGenderRatioDropdown);
        }
        
        dropdownInitialized = true;
    }
}

