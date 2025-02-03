const fs = require('fs');
const dataRefactory = require('../data-refactory');

// Read the JSON file
fs.readFile('./data2.json', 'utf8', (err, data) => {
    if (err) {
        console.error("Error reading file:", err);
        return;
    }

    const jsonData = JSON.parse(data);

    console.log(dataRefactory.getPrompt(jsonData, "en"));

});

