

(async function(){
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
    */
    try {
        const response = await ollama.chat({
            model: 'llama3.2',
            messages: [{ role: 'user', content: 'Tell me about Canada.' }],
            format: zodToJsonSchema(Country),
        });

        const country = Country.parse(JSON.parse(response.message.content));
        console.log(country);
    }
    catch (error) {
        console.error(123);
    }
    
})();
