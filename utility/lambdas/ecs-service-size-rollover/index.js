// Invoked by: CloudFormation
// Returns: A `Data` object to a pre-signed URL
//
// Used as part of an ECS service custom resource, which allows for the
// DesiredSize of a service to be persisted across CloudFormation deploys.
// The name of the a cluster and service is passed in as part of the event data,
// and a query is made to the ECS API to get the current value, which is then
// returned and made available to other CloudFormation resources.

const https = require('https');
const url = require('url');
// const AWS = require('aws-sdk');

const STATUS_SUCCESS = 'SUCCESS';
// const STATUS_FAILED = 'FAILED';

const HTTP_PUT = 'PUT';

// Send response to the pre-signed S3 URL
function sendResponse(event, context, responseStatus, responseData) {
    const crResponse = {
        Status: responseStatus,
        Reason: `CloudWatch Logs: ${context.logStreamName}`,
        PhysicalResourceId: context.logStreamName,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        Data: responseData,
    };

    const responseBody = JSON.stringify(crResponse);

    const parsedUrl = url.parse(event.ResponseURL);
    const options = {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: HTTP_PUT,
        headers: {
            'content-type': '',
            'content-length': responseBody.length,
        },
    };

    const request = https.request(options, () => {
        context.done();
    });

    request.on('error', (error) => {
        console.log(`sendResponse Error: ${error}`);
        // Tell AWS Lambda that the function execution is done
        context.done();
    });

    // write data to request body
    request.write(responseBody);
    request.end();
}

exports.handler = (event, context) => {
    // For Delete requests, immediately send a SUCCESS response.
    if (event.RequestType === 'Delete') {
        sendResponse(event, context, STATUS_SUCCESS);
        return;
    }

    const responseData = {
        foo: 'bar',
    };

    sendResponse(event, context, STATUS_SUCCESS, responseData);
};
