import { Handler } from 'aws-lambda';

export const handler: Handler = async (event) => {
    console.log('Vector processor Lambda invoked', { event });
    return { statusCode: 200, body: 'OK' };
};
