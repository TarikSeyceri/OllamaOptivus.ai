require('dotenv').config();
const swaggerAutogen = require('swagger-autogen')();

const outputFile = './src/swagger.json';
const endpointsFiles = ['./src/api.js'];

const swaggerConfig = {
    info: {
        title: 'Ollama Optivus AI API',
        description: 'By Tarik Seyceri',
    },
    host: 'localhost:' + (process.env.HTTP_PORT || 3330),
    schemes: ['http'],
};

swaggerAutogen(outputFile, endpointsFiles, swaggerConfig);