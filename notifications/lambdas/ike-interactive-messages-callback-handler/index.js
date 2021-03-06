// Invoked by: API Gateway
// Returns: Error, or API Gateway proxy response object
//
// When a user acts on an interactive message in Slack (eg., clicks a button),
// Slack will send a request to a callback This function handles those requests,
// such as for approving CloudFormation deploys through CodePipeline.

const querystring = require('querystring');
const crypto = require('crypto');

const aws = require('aws-sdk');
const s3 = new aws.S3({apiVersion: '2006-03-01'});
const codepipeline = new aws.CodePipeline({apiVersion: '2015-07-09'});

const APPROVED = 'Approved';
const REJECTED = 'Rejected';

const CODEPIPELINE_MANUAL_APPROVAL_CALLBACK = 'codepipeline-approval-action';

const ROLLBACK_VERSION_SELECTION_CALLBACK = 'rollback-version-selection-action';

exports.handler = (event, context, callback) => {
    try {
        processEvent(event, context, callback);
    } catch (e) {
        callback(e);
    }
};

function processEvent(event, context, callback) {
    const body = querystring.parse(event.body);

    // The JSON object response from Slack
    const payload = JSON.parse(body.payload);

    // Top-level properties of the message action response object
    const action = payload.actions[0];
    const callbackId = payload.callback_id;
    const token = payload.token;

    // Slack signing secret
    const slackRequestTimestamp = event.headers['X-Slack-Request-Timestamp'];
    const basestring = ['v0', slackRequestTimestamp, event.body].join(':');
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    const slackSignature = event.headers['X-Slack-Signature'];
    const requestSignature = `v0=${crypto.createHmac('sha256', signingSecret).update(basestring).digest('hex')}`;

    if (requestSignature !== slackSignature) {
        // Bad request; bogus token
        callback(null, { statusCode: 400, headers: {}, body: null });
    } else {
        // Handle each callback ID appropriately
        switch (callbackId) {
            case CODEPIPELINE_MANUAL_APPROVAL_CALLBACK:
                handleCodePipelineApproval(payload, callback);
                break;
            case ROLLBACK_VERSION_SELECTION_CALLBACK:
                handleRollbackCallback(payload, callback);
                break;
            default:
                // Unknown message callback
                callback(null, { statusCode: 400, headers: {}, body: null });
        }
    }
}

function handleRollbackCallback(payload, callback) {
    const action = payload.actions[0];

    switch (action.name) {
        case 'selection':
            triggerRollback(payload, callback)
            break;
        default:
            cancelRollback(payload, callback);
    }
}

function triggerRollback(payload, callback) {
    const action = payload.actions[0];
    const versionId = action.selected_options[0].value;

    const configBucket = process.env.INFRASTRUCTURE_CONFIG_BUCKET;
    const configKey = process.env.INFRASTRUCTURE_CONFIG_STAGING_KEY;
    const sourceUrl = `${configBucket}/${configKey}?versionId=${versionId}`;

    s3.copyObject({
        Bucket: configBucket,
        CopySource: encodeURI(sourceUrl),
        Key: configKey
    }, (e, data) => {
        if (e) {
            console.error(e);
            callback(null, { statusCode: 400, headers: {}, body: null });
        } else {
            const msg = {
                text: `Rolling back to config version: ${versionId}`
            };

            const body = JSON.stringify(msg);
            callback(null, { statusCode: 200, headers: {}, body: body });
        }
    });
}

function cancelRollback(payload, callback) {
    const msg = {
        text: '_Rollback canceled_'
    };

    const body = JSON.stringify(msg);
    callback(null, { statusCode: 200, headers: {}, body: body });
}

function handleCodePipelineApproval(payload, callback) {
    const action = payload.actions[0];

    // The manual approval notifications params need to be extracted from
    // the action value, where they are stored as stringified JSON data.
    const extractedParams = JSON.parse(action.value);

    // We're going to immediately update the message that triggered the
    // action based on the action taken and the result of that action.
    // We'll use the original message as a starting point, but need to
    // remove some unnecessary properties before sending it back
    const attachment = payload.original_message.attachments[0];
    delete attachment.actions;
    delete attachment.id;
    delete attachment.callback_id;

    // Build the params that get sent back to CodePipeline to approve or
    // reject the pipeline
    const approvalParams = {
        pipelineName: extractedParams.pipelineName,
        stageName: extractedParams.stageName,
        actionName: extractedParams.actionName,
        token: extractedParams.token,
        result: {
            status: extractedParams.value,
            summary: 'Handled by Ike'
        },
    };

    codepipeline.putApprovalResult(approvalParams, (err, data) => {
        if (err) {
            // There was an error making the putApprovalResult request to
            // CodePipeline, so the user should be notified that their
            // action was not successful
            const body = JSON.stringify({ test: `Error: ${err}` });
            callback(null, { statusCode: 200, headers: {}, body: body });
        } else {
            // The putApprovalResult request was successful, so the message
            // in Slack should be updated to remove the buttons

            const msg = { text: '', attachments: [attachment] };

            switch (extractedParams.value) {
                case REJECTED:
                    attachment.text = attachment.text + `\n*<@${payload.user.id}> rejected this deploy*`;
                    attachment.color = '#de0e0e';
                    break;
                case APPROVED:
                    attachment.text = attachment.text + `\n:white_check_mark: *<@${payload.user.id}> approved this deploy*`;
                    attachment.color = '#15da34';
                    break;
                default:
                    attachment.text = attachment.text + `\nUnknown action by <@${payload.user.id}>`;
                    attachment.color = '#cd0ede';
            }

            const body = JSON.stringify(msg);
            callback(null, { statusCode: 200, headers: {}, body: body });
        }
    });
}
