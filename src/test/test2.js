const ollama = require('ollama').default;
const { z } = require('zod');
const { zodToJsonSchema } = require('zod-to-json-schema');

(async function(){
    /*
    const Country = z.object({
        name: z.string(),
        capital: z.string(), 
        languages: z.array(z.string()),
    });
    /*
    console.log(JSON.stringify({
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'Tell me about Canada.' }],
        format: zodToJsonSchema(Country),
    }, null, 2));
    
    try {
        const response = await ollama.generate({
            model: 'llama3.2',
            prompt: 'Tell me about Canada.',
            format: zodToJsonSchema(Country),
        });

        //const country = Country.parse(JSON.parse(response.message.content));
        console.log(response);
    }
    catch (error) {
        console.error(error);
    }
        */
    
    const test1 = await ollama.list();

    console.log(test1);
})();
