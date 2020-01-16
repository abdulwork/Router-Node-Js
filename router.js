"use strict";

const path = require("path");
const fs = require("fs");

const _ = require("lodash");
const Promise = require("bluebird");
const moment = require("moment");
const jwt = require("jwt-simple");
const csv = require("fast-csv");
const createError = require("http-errors");
const expressPromiseRouter = require("express-promise-router");

const ObjectId = require("mongoose").Types.ObjectId;

const config = require("gigit-common/config");

const { Auction, Notification, Order, Payment, RatingHistory, Request, Space, Store, StripeAccount, SystemEvent, User } = require("gigit-common/models");
const { reqGigitAdmin, reqGenericModel, reqSaveToken, optSaveToken } = require("gigit-common/middleware");
const logger = require("gigit-common/loggers").logger;

const router = expressPromiseRouter();

var existingStatistics = null;

// #region getStatistics
/*
 * Users, gigs posted, gigs completed, applications accepted, 
 * applications submitted, total dollars paid to all gigs, total volunteer hours
 */
function getStatistics(req, res) {
    return Promise.try(function() {
        if (existingStatistics) {
            var expiryTime = moment(existingStatistics.computedTime).add(10, "minutes");
            var expired = moment().isAfter(expiryTime);
            if (!expired) {
                return res.status(200).send(existingStatistics);
            }
        }

        // Join the above promises, when they are all complete
        return Promise.join(countUsers(), countRequests(), countOrders(), countSpaces(),
            function(userStats, requestStats, orderStats, spacesStats) {
                // Fields that aren't being assigned a value
                /*
                    numberVolunteerPositions: 0,
                    numberVolunteerHoursRequested: 0,
                    numberRequestedAppointments: 0,
                    numberAppointmentsBooked: 0,
                    numberAppointmentsCompleted: 0,
                    numberAppointmentsCancelled: 0,
                    numberAppointmentsExpired: 0,
                    totalDollarsEarned: 0,
                    totalDollarThroughput: 0
                */

                var statisticsObject = {
                    computedTime: moment().valueOf()
                };
                Object.assign(statisticsObject, userStats, requestStats, orderStats, spacesStats);
                existingStatistics = statisticsObject;
                res.status(200).send(statisticsObject);
            })
            .catch(function(err) {
                // If any of the promises fail, return an error message
                throw new Error("Error calculating metrics");
            });
    });
}

function countUsers() {
    return Promise.try(function() {
        return User.find({})
            .select("type")
            .exec();
    })
        .then(function(users) {
            var userStats = {
                numberUsers: 0,
                numberGroups: 0
            };

            users.forEach(function(user) {
                if (user.type === "company") {
                    userStats.numberGroups++;
                }
                else {
                    userStats.numberUsers++;
                }
            });

            return userStats;
        })
        .catch(function(err) {
            logger.error("Error calculating user metrics: ", err);
            throw err;
        });
}

function countRequests() {
    return Promise.try(function() {
        return Request.find({})
            .select("isOffer proposals offer isEvent request_date isTemplate type status")
            .exec();
    })
        .then(function(requests) {
            var requestStats = {
                numberEvents: 0,
                numberUpcomingEvents: 0,
                numberServicesOffered: 0,
                numberVolunteerGigs: 0,
                futureVolunteerHours: 0,
                offeredVolunteerHours: 0,
                numberPaidGigs: 0,
                numberAdHocGigs: 0,
                totalNumberGigs: 0,
                numberApplicationsSubmitted: 0
            };

            var now = moment();

            requests.forEach(function(currentRequest) {
                if (currentRequest.isEvent) {
                    requestStats.numberEvents++;
                    if (currentRequest.request_date && moment(currentRequest.request_date).isAfter(now)) {
                        requestStats.numberUpcomingEvents++;
                    }
                }
                else if (currentRequest.isTemplate) {
                }
                else if (currentRequest.isOffer) {
                    requestStats.numberServicesOffered++;
                }
                else {
                    if (currentRequest.type === "volunteer") {
                        requestStats.numberVolunteerGigs++;
                        if (currentRequest.offer.time &&
                            (currentRequest.offer.time.units === "hours")) {
                            var numberHours = currentRequest.offer.time.value > 0 ? currentRequest.offer.time.value : 0;
                            requestStats.offeredVolunteerHours += numberHours;
                            if (currentRequest.status.code !== "cancelled" && currentRequest.offer.start_date && moment(currentRequest.offer.start_date).isAfter(now)) {
                                requestStats.futureVolunteerHours += numberHours;
                            }
                        }
                    }
                    else if (currentRequest.type === "paid") {
                        requestStats.numberPaidGigs++;
                    }
                    else if (currentRequest.type === "ad-hoc") {
                        requestStats.numberAdHocGigs++;
                    }

                    requestStats.totalNumberGigs++;
                    currentRequest.proposals.forEach(function(proposal) {
                        if (proposal && (!proposal.status || proposal.status.code !== "cancelled")) {
                            requestStats.numberApplicationsSubmitted++;
                        }
                    });
                }
            });

            return requestStats;
        })
        .catch(function(err) {
            logger.error("Error calculating request metrics: ", err);
            throw err;
        });
}

function countOrders() {
    return Promise.try(function() {
        return Order.find({})
            .select("status completions proposals type")
            .exec();
    })
        .then(function(orders) {
            var orderStats = {
                numberVolunteerGigsCompleted: 0,
                numberPaidGigsCompleted: 0,
                numberAdHocGigsCompleted: 0,
                numberGigsCompleted: 0,
                totalVolunteerHours: 0,
                totalDollarsPaid: 0
            };

            orders.forEach(function(order) {
                if (!(order.status && order.status.code === "done")) {
                    return;
                }
                if (order.type === "volunteer") {
                    orderStats.numberVolunteerGigsCompleted++;
                }
                else if (order.type === "paid") {
                    orderStats.numberPaidGigsCompleted++;
                }
                else if (order.type === "ad-hoc") {
                    orderStats.numberAdHocGigsCompleted++;
                }
                orderStats.numberGigsCompleted++;

                order.completions.forEach(function(completion) {
                    if (completion.status && completion.status.code === "accepted") {
                        var proposal = order.proposals.find(function(proposal) {
                            return proposal.owner_id === completion.owner_id;
                        });
                        if (proposal) {
                            if (order.type === "volunteer") {
                                orderStats.totalVolunteerHours += proposal.time.value;
                            }
                            else {
                                orderStats.totalDollarsPaid += proposal.time.value * proposal.money.value;
                            }
                        }
                    }
                });
            });

            return orderStats;
        })
        .catch(function(err) {
            logger.error("Error calculating order metrics: ", err);
            throw err;
        });
}

function countSpaces() {
    return Promise.try(function() {
        return Space.find({})
            .select("client_bookings availability")
            .exec();
    })
        .then(function(spaces) {
            var spacesStats = {
                numberSpacesCreated: 0,
                numberSpacesRented: 0,
                numberSpacesAvailable: 0
            };

            spacesStats.numberSpacesCreated = spaces.length;
            spaces.forEach(function(currentSpace) {
                var hasRental = currentSpace.client_bookings.some(function(booking) {
                    return booking.bookingType === "rental";
                });
                if (hasRental) {
                    spacesStats.numberSpacesRented++;
                    spacesStats.numberSpacesAvailable++;
                    return;
                }
            });

            return spacesStats;
        })
        .catch(function(err) {
            logger.error("Error calculating space metrics: ", err);
            throw err;
        });
}
// #endregion

// #region getStatus
var upSince = new Date();

function getStatus(req, res) {
    res.status(200).send({ upSince: upSince });
}
// #endregion

// #region Generic Maintenance Routes
function genericGetRoute(req, res) {
    return Promise.try(function() {
        var model = res.locals.model;
        var query = req.body.query;
        var populate = req.body.populate || [];
        var select = req.body.select;
        var format = req.body.format || "json";

        return model.find(query)
            .select(select)
            .populate(populate)
            .lean()
            .exec()
            .then(function(results) {
                if (format === "csv") {
                    res.csv(results, true);
                }
                else {
                    res.status(200).send(results);
                }
            });
    });
}

function genericRefRoute(req, res) {
    return Promise.try(function() {
        var model = res.locals.model;
        var query = req.body.query;

        var refField = req.body.refField;
        var refModel = res.locals.refModel;
        var refQuery = req.body.refQuery;

        if (!query) {
            throw createError(422, "Missing query");
        }
        if (!refField) {
            throw createError(422, "Missing refField");
        }
        if (!refQuery) {
            throw createError(422, "Missing refQuery");
        }

        return model.find(query).lean().exec()
            .then(function(objects) {
                var refIds = Array.from(new Set(objects.map(object => object[refField].toString())));
                refQuery._id = { $in: refIds };
                return refModel.find(refQuery).exec();
            })
            .then(function(results) {
                res.status(200).send(results);
            });
    });
}

function genericUniqueRoute(req, res) {
    return Promise.try(function() {
        var model = res.locals.model;
        var query = req.body.query;
        var selection = req.body.selection;

        if (!query) {
            return res.status(422).send("Missing query");
        }
        if (!selection) {
            return res.status(422).send("Missing selection");
        }

        return model.find(query).select(selection).lean().exec().then(function(objects) {
            var uniqueValues = findUniqueValues(objects, selection);
            return res.status(200).send(uniqueValues);
        });
    });
}

function dotTraverse(tree, path) {
    if (!path) {
        return tree;
    }
    var steps = path.split(".");
    var end = steps.reduce(function(branch, step) {
        if (!branch) {
            return undefined;
        }
        return branch[step];
    }, tree);
    return end;
}

function findUniqueValues(objects, path) {
    var uniqueValues = new Set();

    if (!path) {
        path = "";
    }

    objects.forEach(function(object) {
        var value = dotTraverse(object, path);
        uniqueValues.add(value);
    });

    return Array.from(uniqueValues).sort();
}

function genericDeleteRoute(req, res) {
    var model = res.locals.model;
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var deleteFields = req.body.deleteFields;
    var deleteFieldsById = req.body.deleteFieldsById;
    var deleteAll = req.body.deleteAll;
    var deleteArray = req.body.deleteArray;

    if (!(deleteFields || deleteFieldsById || deleteAll || deleteArray)) {
        return res.status(400).send("Nothing to delete!");
    }
    if (query == null) {
        return res.status(500).send("No query");
    }

    model.findOne(query, function(findError, object) {
        if (findError) {
            return res.status(500).send(findError);
        }
        else if (object == null) {
            return res.status(500).send({ gigitError: "no objects found " });
        }

        if (deleteFieldsById) {
            var currentObject = object;
            var previousObject;
            deleteFieldsById.forEach(function(currentField) {
                previousObject = currentObject[currentField.field];
                currentObject = currentObject[currentField.field];
                if (currentField.id != null) {
                    currentObject = currentObject.find(function(arrayObject) {
                        return arrayObject._id.equals(currentField.id);
                    });
                }
            });
            var removeIndex = previousObject.indexOf(currentObject);
            previousObject.splice(removeIndex, 1);
            object.markModified(deleteFieldsById[0]);
        }
        else if (deleteAll) {
            if (!saveEnabled) {
                return res.status(200).send(object);
            }
            object.remove(function(saveError, savedObject) {
                if (saveError) {
                    return res.status(500).send(saveError);
                }
                return res.status(200).send(savedObject);
            });
            return;
        }
        else if (deleteFields) {
            deleteFields.forEach(function(deleteField) {
                delete object[deleteField];
                object.markModified(deleteField);
            });
        }
        else if (deleteArray != null) {
            object[deleteArray] = [];
            object.markModified(deleteArray);

        }
        else {
            return res.status(400).send("Nothing to delete!");
        }
        if (!saveEnabled) {
            return res.status(200).send(object);
        }
        object.save(function(saveError, savedObject) {
            if (saveError) {
                return res.status(500).send(saveError);
            }
            return res.status(200).send(savedObject);
        });
    });
}

function genericTranslate(req, res) {
    var model = res.locals.model;
    var query = req.body.query;
    var updates = req.body.updates;

    model.find(query, function(findError, objects) {
        if (findError == null) {
            return res.status(500).send(findError);
        }
        objects.forEach(function(object) {
            updates.forEach(function(update) {
                var finalValue;
                var currentValue = object;
                var updateTokens = update.fromField.split(".");
                object.markModified(updateTokens[0]);
                for (let index = 0; index < updateTokens.length - 1; index++) {
                    if (currentValue != null) {
                        currentValue = currentValue[updateTokens[index]];
                    }
                }
                if (currentValue != null) {
                    finalValue = currentValue[updateTokens[updateTokens.length - 1]];
                    delete currentValue[updateTokens[updateTokens.length - 1]];
                }
                var currentField = object;
                var updateFields = update.toField.split(".");
                object.markModified(updateFields[0]);
                for (let index = 0; index < updateFields.length - 1; index++) {
                    if (currentField != null) {
                        currentField = currentField[updateFields[index]];
                    }
                }
                if ((currentField != null) && (finalValue != null)) {
                    currentField[updateFields[updateFields.length - 1]] = finalValue;
                }
            });
            object.save();
        });
    });
}

function genericCreateRoute(req, res) {
    var model = res.locals.model;
    var updates = req.body.updates;

    model.create(updates, function(createError, createdObject) {
        if (createError) {
            return res.status(500).send(createError);
        }
        return res.status(200).send(createdObject);
    });
}

async function genericChangeField(req, res) {
    var model = res.locals.model;
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var changes = req.body.changes;

    var object = await model.findOne(query);

    // $set
    // $push
    // $id
    // $status
    Object.entries(changes).forEach(function([path, change]) {
        if (typeof change !== "object" || Object.keys(change).length !== 1) {
            throw createError(400, "Bad change value for " + path);
        }
        var [changeType, value] = Object.entries(change)[0];

        if (changeType === "$set") {
            _.set(object, path, value);
        }
        else if (changeType === "$setid") {
            _.set(object, path, ObjectId(value));
        }
        else if (changeType === "$setstatus") {
            _.set(object, path, { code: value, date: new Date() });
        }
        else if (changeType === "$push") {
            var hasPath = _.has(object, path);
            if (!hasPath) {
                _.set(object, path, []);
            }

            var arr = _.get(object, path, value);
            if (!Array.isArray(arr)) {
                throw createError(path + " is not an array");
            }
            arr.push(value);
        }
        else {
            throw createError(400, "Unrecognized changeType " + changeType);
        }

        var fieldName = _.toPath(path)[0];
        object.markModified(fieldName);
    });

    if (!saveEnabled) {
        return res.status(200).send(object);
    }

    var savedObject = await object.save();
    return res.status(201).send(savedObject);
}

function genericTransfer(req, res) {
    var toModel = res.locals.toModel;
    var fromModel = res.locals.fromModel;
    var fromQuery = req.body.fromQuery;
    var linkField = req.body.linkField;
    var toField = req.body.toField;
    var fromField = req.body.fromField;

    var sent = false;
    fromModel.find(fromQuery, function(error, fromObjects) {
        if (error) {
            return res.status(500).send(error);
        }
        fromObjects.forEach(function(currentObject) {
            var linkQuery = {};
            linkQuery[linkField] = currentObject[linkField];
            toModel.find(linkQuery, function(linkError, links) {
                if (linkError) {
                    logger.error("Link error: ", linkError);
                }
                links.forEach(function(currentLink) {
                    currentLink[toField] = currentObject[fromField];
                    currentLink.save(function() {
                        if (sent) {
                            return;
                        }
                        sent = true;
                        logger.debug("object: ", currentObject);
                        logger.debug("link: ", currentLink);
                    });
                });
            });
        });
        return res.status(200).send("Tried!");
    });
}

function genericInject(req, res) {
    var model = res.locals.model;
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var injectData = req.body.injectData;
    var injectToField = req.body.injectToField;
    var injectToFieldId = req.body.injectToFieldId;

    model.findOne(query, function(findError, parentObject) {
        if (findError) {
            return res.status(500).send(findError);
        }
        else if (parentObject == null) {
            return res.status(404).send({ gigitError: "Not found!" });
        }

        var subFields = injectToField.split(".");
        var subIds = injectToFieldId.split(".");

        var currentObject = parentObject;
        parentObject.markModified(subFields[0]);
        var currentField;
        var currentFieldId;
        for (var index = 0; index < subFields.length; index++) {
            currentField = subFields[index];
            currentFieldId = subIds.length > index ? subIds[index] : null;
            if (currentFieldId != null) {
                currentObject = currentObject[currentField].find(function(currentSubObject) {
                    return currentSubObject._id.toString() === currentFieldId;
                });
            }
            else {
                var injectArray = injectData;
                if (currentField === "enum_opts") {
                    injectArray = injectData.map(function(currentData) {
                        return [{ text: currentData, language: "en" }];
                    });
                    currentObject[currentField] = injectArray;
                }
                else {
                    currentObject[currentField].push.apply(currentObject, injectArray);
                }
            }
        }

        if (saveEnabled) {
            parentObject.save(function(saveError, newObject) {
                if (saveError) {
                    return res.status(500).send(saveError);
                }
                res.status(200).send(newObject);
            });
        }
        else {
            res.status(200).send(parentObject);
        }
    });
}

function addUniqueValuesToList(req, res) {
    var model = res.locals.model;
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var field = req.body.field;
    var idValues = req.body.idValues;

    model.findOne(query, function(objectError, object) {
        if (objectError) {
            return res.status(500).send(objectError);
        }
        else if (object == null) {
            return res.status(404).send({ gigitError: "No objects found" });
        }

        var fields = field.split(".");
        var index = 0;
        var baseField = fields[index];
        var array = object;

        while (array[fields[index]] != null) {
            array = array[fields[index++]];
        }

        idValues.forEach(function(currentId) {
            var existingValue = array.find(function(currentElement) {
                return currentElement.equals(currentId);
            });
            if (existingValue == null) {
                array.push(ObjectId(currentId));
            }
        });

        if (!saveEnabled) {
            return res.status(200).send(object);
        }
        object.markModified(baseField);
        object.save(function(saveObjectError, savedObject) {
            if (saveObjectError) {
                return res.status(500).send(saveObjectError);
            }

            return res.status(200).send(savedObject);
        });
    });
}

function pushArrayValue(req, res) {
    var model = res.locals.model;
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var field = req.body.field;
    var value = req.body.value;
    var idValues = req.body.idValues;

    model.findOne(query, function(objectError, object) {
        if (objectError) {
            return res.status(500).send(objectError);
        }
        else if (object == null) {
            return res.status(404).send({ gigitError: "No objects found" });
        }
        var array = object[field];
        if (idValues === "object") {
            value = ObjectId(value);
        }
        else if (idValues != null) {
            idValues.forEach(function(idField) {
                value[idField] = ObjectId(value[idField]);
            });
        }

        object.markModified(field);
        array.push(value);

        if (!saveEnabled) {
            return res.status(200).send(object);
        }

        object.save(function(saveError, newObject) {
            if (saveError) {
                return res.status(500).send(saveError);
            }
            res.status(200).send(newObject);
        });
    });
}

function modifyArrayValue(req, res) {
    var model = res.locals.model;
    var query = req.body.query;
    var fieldQuery = req.body.fieldQuery;

    if ((fieldQuery == null) || (fieldQuery.length == null) || (fieldQuery.length === 0)) {
        return res.status(500).send("Bad fieldQuery");
    }

    model.findOne(query, function(objectError, object) {
        if (objectError) {
            return res.status(500).send(objectError);
        }
        else if (object == null) {
            return res.status(404).send({ gigitError: "No objects found" });
        }
        var currentObject = object;
        object.markModified(fieldQuery[0].field);
        fieldQuery.forEach(function(currentField) {
            if (currentField.newValue == null) {
                currentObject = currentObject[currentField.field];
            }
            else {
                var modifyObject = currentObject.find(function(currentArrayValue) {
                    if (currentArrayValue[currentField.testArrayField].equals) {
                        return currentArrayValue[currentField.testArrayField].equals(currentField.testArrayValue);
                    }
                    return currentArrayValue[currentField.testArrayField] == currentField.testArrayValue;
                });
                if (modifyObject == null) {
                    return res.status(404).send({ currentObject: currentObject, currentField: currentField });
                }
                var value = currentField.newValue;
                if (currentField.objectId) {
                    value = ObjectId(value);
                }
                if (currentField.newValue === "newID") {
                    modifyObject[currentField.field] = ObjectId();
                }
                else {
                    modifyObject[currentField.field] = value;
                }
            }
        });

        object.save(function(saveError, newObject) {
            if (saveError) {
                return res.status(500).send(saveError);
            }
            res.status(200).send(newObject);
        });
    });
}

function testAggregate(req, res) {
    var model = res.locals.model;
    var query = req.body.query;
    var params = req.body.params;

    model.find(query).exec(params, function(queryError, results) {
        if (queryError) {
            return res.status(500).send(queryError);
        }

        return res.status(200).send(results);
    });
}

function addArrayDuplicates(req, res) {
    var model = res.locals.model;
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var arrayField = req.body.arrayField;

    model.findOne(query, function(error, object) {
        if (error) {
            return res.status(500).send(error);
        }
        if (Array.isArray(object[arrayField])) {
            var duplicates = [];
            object[arrayField].forEach(function(currentArrayElement) {
                duplicates.push(Object.assign({}, currentArrayElement));
            });
            duplicates.forEach(function(currentDuplicate) {
                object[arrayField].push(currentDuplicate);
            });

            object.markModified(arrayField);
            if (!saveEnabled) {
                return res.status(200).send(object);
            }
            object.save(function(error, savedObject) {
                if (error) {
                    return res.status(500).send(error);
                }
                return res.status(200).send(savedObject);
            });
        }
        else {
            return res.status(404).send("Array not found!");
        }
    });
}

function removeArrayDuplicates(req, res) {
    var model = res.locals.model;
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var uniqueField = req.body.uniqueField;
    var arrayField = req.body.arrayField;

    model.findOne(query, function(error, object) {
        if (error) {
            return res.status(500).send(error);
        }
        if (Array.isArray(object[arrayField])) {
            var objectKeys = {};
            object[arrayField] = object[arrayField].filter(function(currentObject) {
                var fieldKey = currentObject.toString();
                if (uniqueField != null) {
                    fieldKey = currentObject[uniqueField] != null ? currentObject[uniqueField].toString() : null;
                }
                if (fieldKey == null) {
                    return true;
                }
                else if (objectKeys[fieldKey]) {
                    return false;
                }
                objectKeys[fieldKey] = true;
                return true;
            });
            object.markModified(arrayField);
            if (!saveEnabled) {
                return res.status(200).send(object);
            }
            object.save(function(error, savedObject) {
                if (error) {
                    return res.status(500).send(error);
                }
                return res.status(200).send(savedObject);
            });
        }
        else {
            return res.status(404).send("Array not found!");
        }
    });
}

function testForDuplicates(req, res) {
    var model = res.locals.model;
    var query = req.body.query;
    var field = req.body.field;
    var uniqueField = req.body.uniqueField;

    model.findOne(query, function(findEventError, object) {
        if (findEventError) {
            return res.status(500).send(findEventError);
        }
        else if (object == null) {
            return res.status(404).send({ gigitError: "No object found!" });
        }
        var array = object[field];
        var objectKeys = {};
        var duplicateObjects = [];
        array.forEach(function(arrayElement) {
            if (objectKeys[arrayElement[uniqueField].toString()]) {
                duplicateObjects.push(arrayElement);
                return;
            }
            objectKeys[arrayElement[uniqueField].toString()] = true;
        });
        var uniqueIds = Object.keys(objectKeys);
        return res.status(200).send({
            originalLength: array.length,
            uniqeLength: uniqueIds.length,
            duplicateObjects: duplicateObjects
        });
    });
}
// #endregion

function fireEmail(req, res) {
    var query = req.body.query;

    if (query) {
        SystemEvent.findOne(query, function(error, oneEvent) {
            if (error) {
                return res.status(500).send(error);
            }
            if (!oneEvent) {
                return res.status(500).send({ gigitError: "SystemEvent not found" });
            }

            oneEvent.status = { code: "fired", date: new Date() };
            oneEvent.save(function(systemError, savedEvent) {
                if (systemError) {
                    return res.status(500).send(systemError);
                }

                return res.status(200).send(savedEvent);
            });
        });
    }
    else {
        // What is this supposed to do?
        for (var index = 0; index < 1000; index++) {
            SystemEvent.findOne({ eventType: index, createdAt: { $gt: 1540958400000 }, "status.code": "handled" }, function(error, oneEvent) {
                if (error) {
                    return res.status(500).send(error);
                }
                if (!oneEvent) {
                    return;
                }

                oneEvent.status = { code: "fired", date: new Date() };
                oneEvent.save();
            });
        }
        return res.status(200).send({ gigitMessage: "Sent" });
    }
}

function changeEmailStatus(req, res) {
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var newStatus = req.body.newStatus;

    if (!newStatus) {
        return res.status(400).send({ gigitError: "New status not found!" });
    }

    Notification.find(query).exec(function(findError, notifications) {
        if (findError) {
            return res.status(500).send(findError);
        }

        notifications.forEach(function(notification) {
            notification.email.status = { code: newStatus, date: new Date() };
            notification.markModified("email");
        });

        if (saveEnabled) {
            notifications.forEach(function(notification) {
                notification.save();
            });
        }
        res.status(200).send(notifications);
    });
}

// #region importStudents
function importStudents(req, res) {
    var saveEnabled = res.locals.saveEnabled;
    var ticketId = req.body.freeStudentTicket;
    var organization = req.body.studentOrganization;
    var storeId = req.body.store_id;
    var groupId = req.body.group_id;
    var eventId = req.body.event_id;

    var processedData = {
        members: [],
        noEmails: []
    };
    var stream = fs.createReadStream(path.join(__dirname, "./students.csv"));
    var firstData;

    var csvStream = csv()
        .on("data", function(data) {
            if (firstData == null) {
                firstData = data.map(function(column) {
                    return column.trim();
                });
                return;
            }

            var testObject = {
                ticketId: ticketId,
                user_id: new ObjectId(),
                org_ids: [organization]
            };
            for (var index = 0; index < firstData.length; index++) {
                if (firstData[index].indexOf("first name") > -1) {
                    testObject.firstName = data[index].trim();
                }
                else if (firstData[index].indexOf("last name") > -1) {
                    testObject.lastName = data[index].trim();
                }
                else if (firstData[index].indexOf("School") > -1) {
                    testObject.school = data[index].trim();
                }
                else if (firstData[index].indexOf("email") > -1) {
                    var parsedEmail = data[index].trim();
                    var emailPrefix = parsedEmail.split("@")[0];
                    testObject.email = "paetkauchristian+7" + emailPrefix + "@gmail.com";
                }
            }
            if (testObject.email.trim() === "") {
                processedData.noEmails.push({ name: testObject.firstName + " " + testObject.lastName });
            }
            else {
                var duplicate = processedData.members.find(function(currentMember) {
                    return currentMember.email === testObject.email;
                });
                if (duplicate != null) {
                    duplicate.ticketId = testObject.ticketId;
                }
                else {
                    processedData.members.push(testObject);
                }
            }
        }).on("end", function() {
            Request.findById(eventId, function(findEventError, event) {
                if (findEventError) {
                    return res.status(500).send(findEventError);
                }
                processedData.event = event;
                createImportedUsers(res, storeId, groupId, eventId, saveEnabled, processedData);
            });
        });
    stream.pipe(csvStream);
}

function createImportedUsers(res, storeId, groupId, eventId, saveEnabled, processedData) {
    processedData.creationErrors = [];
    processedData.createdUsers = [];
    processedData.existingUsers = [];
    processedData.payments = [];

    var totalCount = processedData.members.length;

    processedData.members.forEach(function(currentUser) {
        User.createMinimalUserHandler(currentUser, function(creationError, user, created) {
            totalCount--;
            if (creationError) {
                processedData.creationErrors.push({ inputData: currentUser, error: creationError });
                if (totalCount === 0) {
                    processCreatedUsers(res, eventId, saveEnabled, processedData);
                }
                return;
            }
            var payment = createPhonyPayment(storeId, groupId, eventId, currentUser, user);
            processedData.payments.push(payment);
            if (created) {
                processedData.createdUsers.push(user);
            }
            else {
                processedData.existingUsers.push(user);
            }
            if (totalCount === 0) {
                processCreatedUsers(res, eventId, saveEnabled, processedData);
            }
        });
    });
}

function createPhonyPayment(storeId, groupId, eventId, currentUser, user) {
    var soldItems = [
        {
            item_type: currentUser.ticketId,
            price: { currency: "cad", value: 0 },
            discountedPrice: { currency: "cad", value: 0 },
            itemData: [
                {
                    dataName: "Please select the school you are attending.",
                    value: currentUser.school
                }
            ],
            quantity: 1
        }
    ];
    if (currentUser.specialTicketId != null) {
        soldItems.push({
            item_type: currentUser.specialTicketId,
            price: { currency: "cad", value: 0 },
            discountedPrice: { currency: "cad", value: 0 },
            quantity: 1
        });
    }
    return new Payment({
        type: "store purchase",
        type_id: storeId,
        payer_id: user._id,
        owner_id: groupId,
        event_id: eventId,
        metadata: [{ name: "special", value: "Free student day" }],
        soldItems: soldItems,
        firstName: currentUser.firstName,
        lastName: currentUser.lastName,
        email: currentUser.email
    });
}

function processCreatedUsers(res, eventId, saveEnabled, processedData) {
    if (!saveEnabled) {
        return res.status(200).send(processedData);
    }

    var courseEvent = processedData.event;

    processedData.payments.forEach(function(currentPayment) {
        currentPayment.save(function(saveError) {
            if (saveError) {
                logger.error("Error saving payment: ", saveError);
                logger.error("Error saving payment: ", currentPayment);
            }
        });
    });

    processedData.createdUsers.forEach(function(newUser) {
        courseEvent.attendees.push({ user: newUser._id, invited: false, status: "definite" });
        newUser.save(function(saveError) {
            if (saveError) {
                logger.error("Error saving course: ", saveError);
                logger.error("Error saving course: ", newUser);
            }
            var courseString = "";
            var reasonObject = {
                reason: "should not show up in template",
                redirectUrl: "/event/" + eventId,
                courseString: courseString,
                emailTemplate: "template03"
            };
            User.sendVerifyEmailNotification(newUser, null, reasonObject);
        });
    });
    courseEvent.save();
    return res.status(200).send(processedData);
}
// #endregion

// #region updateRatingFor
function updateRatingFor(req, res) {
    var userId = req.body.user_id;

    var query = {
        "status.code": "done",
        $or: [
            { owner_id: userId },
            { "completions.owner_id": userId }
        ]
    };
    Order.find(query)
        .populate("owner")
        .populate("proposals.owner")
        .exec(function(findOrderError, orders) {
            if (findOrderError) {
                return res.status(500).send(findOrderError);
            }
            orders.forEach(function(currentOrder) {
                var caluclateRatingForOrder = createCalculateRatingForOrder(currentOrder);
                User.findById(userId, caluclateRatingForOrder);
            });
            return res.status(204).send();
        });
}

function createCalculateRatingForOrder(currentOrder) {
    return function(error, user) {
        currentOrder.owner = user;
        var findByOwner = createFindByOwnerFunction(user._id);
        if (currentOrder.owner_id.equals(user._id)) {
            currentOrder.completions.forEach(function(currentCompletion) {
                var proposal = currentOrder.proposals.find(findByOwner);
                if (proposal != null) {
                    RatingHistory.updateRating(currentOrder, currentCompletion, proposal, false);
                }
            });
        }
        else {
            var completion = currentOrder.completions.find(findByOwner);
            var proposal = currentOrder.proposals.find(findByOwner);
            RatingHistory.updateRating(currentOrder, completion, proposal, true);
        }
    };
}

function createFindByOwnerFunction(userId) {
    return function(currentObject) {
        if (currentObject.owner_id == null) {
            return false;
        }
        return currentObject.owner_id.equals(userId);
    };
}
// #endregion

function resetPassword(req, res) {
    var email = req.body.email;
    var password = req.body.password;

    if (!email) {
        return res.status(400).send("Missing email field");
    }

    var query = { email: email };
    User.findOne(query, function(findError, user) {
        if (findError) {
            return res.status(500).send(findError);
        }
        else if (!user) {
            return res.status(404).send("User not found!");
        }

        user.password = password;
        user.save(function(saveError) {
            if (saveError) {
                return res.status(500).send(saveError);
            }

            return res.status(200).send("Password changed!");
        });
    });
}

// This shouldn't be needed. Tokens are only signed, not encrypted.
function decodeToken(req, res) {
    var token = req.body.token;

    var payload = jwt.decode(token, config.auth.tokenSecret);
    return res.status(200).send(payload);
}

function addTicketHolders(req, res) {
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;

    Request.findOne(query, function(findEventError, event) {
        if (findEventError) {
            return res.status(500).send(findEventError);
        }
        else if (!event) {
            return res.status(404).send({ gigitError: "No event found!" });
        }

        var beforeAttendees = event.attendees.slice(0);

        var storeQuery = { owner_id: event._id };
        Store.findOne(storeQuery, function(findStoreError, store) {
            if (findStoreError) {
                return res.status(500).send(findStoreError);
            }
            else if (!store) {
                return res.status(404).send({ gigitError: "No store found!" });
            }

            var eventTicketIds = store.availableItems
                .filter(function(storeItem) {
                    return storeItem.itemType === "ticket" && storeItem.requiredForAttendance;
                })
                .map(function(storeItem) {
                    return storeItem._id;
                });

            var purchaseQuery = {
                type_id: store._id,
                "soldItems.item_type": eventTicketIds,
                "refundItems.item_type": { $nin: eventTicketIds }
            };
            Payment.find(purchaseQuery, function(findPurchaseError, purchases) {
                if (findPurchaseError) {
                    return res.status(500).send(findPurchaseError);
                }
                else if (purchases.length === 0) {
                    return res.status(404).send({ gigitError: "No purchases found!" });
                }

                var objectKeys = {};
                purchases.forEach(function(currentPurchase) {
                    objectKeys[currentPurchase.payer_id.toString()] = true;
                });
                var attendeesToAdd = Object.keys(objectKeys);

                attendeesToAdd = attendeesToAdd.filter(function(iterationAttendee) {
                    return !event.attendees.some(function(eventAttendee) {
                        return eventAttendee.user.equals(iterationAttendee);
                    });
                });

                attendeesToAdd.forEach(function(newAttendee) {
                    event.attendees.push({
                        user: newAttendee,
                        invited: false,
                        status: "definite"
                    });
                });

                res.status(200).send({
                    before: beforeAttendees,
                    after: event.attendees
                });

                if (saveEnabled) {
                    event.markModified("attendees");
                    event.save();
                }
            });
        });
    });
}

function getAuthenticationToken(req, res) {
    return Promise.try(function() {
        var userId = req.body.user_id;
        var query = req.body.query;

        var promise;
        if (userId) {
            promise = Promise.resolve(userId);
        }
        else {
            promise = User.findOne(query).exec()
                .then(function(user) {
                    if (!user) {
                        throw createError(404, { gigitError: "User not found!" });
                    }
                    return user._id;
                });
        }

        return promise
            .then(function(userId) {
                var payload = {
                    sub: userId,
                    iat: moment().unix(),
                    exp: moment().add(14, "days").unix()
                };

                return res.status(200).send({ token: jwt.encode(payload, config.auth.tokenSecret) });  // Login token; used for "Login as..."
            });
    });
}

function createRegistrationLink(req, res) {
    var groupId = req.params.groupId;
    var referralCode = req.body.referralCode;
    var joinGroup = req.body.joinGroup;

    var tokenBody = {
        types: ["group"],
        groupId: groupId,
        autoReferralCode: referralCode,
        joinGroup: joinGroup
    };

    var link = config.html5.urls.register + jwt.encode(tokenBody, config.auth.tokenSecret);
    link += "?redir=/neighbourhood-manage/" + groupId;
    return res.status(200).send({ registrationLink: link });
}

function resetAuction(req, res) {
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var itemAuctionId = req.params.itemAuctionId;

    Auction.findOne(query)
        .populate("auctions")
        .exec(function(findAuctionError, auction) {
            if (findAuctionError) {
                return res.status(500).send(findAuctionError);
            }
            var itemAuction = auction.auctions.find(function(currentItemAuction) {
                return currentItemAuction._id.equals(itemAuctionId);
            });

            if (itemAuction != null) {
                var closedAuction = auction.closedAuctions.find(function(currentClosed) {
                    return currentClosed.item_auction_id.equals(itemAuctionId);
                });
                if (closedAuction == null) {
                    return res.status(401).send({ gigitError: "Closed auction not found!" });
                }
                var spliceIndex = auction.closedAuctions.indexOf(closedAuction);
                auction.closedAuctions.splice(spliceIndex, 1);
                auction.markModified("closedAuctions");
                itemAuction.status = { code: "new", date: new Date() };
                itemAuction.bidHistory = [];
                itemAuction.markModified("status");
                itemAuction.markModified("bidHistory");
            }
            else {
                return res.status(404).send("Item auction not found!");
            }

            if (!saveEnabled) {
                return res.status(200).send({
                    auction: auction,
                    itemAuction: itemAuction
                });
            }
            auction.save(function(saveAuctionError, savedAuction) {
                if (saveAuctionError != null) {
                    return res.status(500).send(saveAuctionError);
                }
                itemAuction.save(function(saveItemAuctionError, savedItemAuction) {
                    if (saveItemAuctionError) {
                        return res.status(500).send(saveItemAuctionError);
                    }
                    return res.status(200).send({
                        auction: savedAuction,
                        itemAuction: savedItemAuction
                    });
                });
            });
        });
}

function modifyBid(req, res) {
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var modifiedBid = req.body.modifiedBid;
    var newValue = req.body.newValue;
    var newUser = req.body.newUser;
    var newBidId = req.body.newBidId;

    Auction.findOne(query, function(error, auction) {
        if (error) {
            return res.status(500).send(error);
        }
        var auctionToChange = auction.closedAuctions.find(function(currentAuction) {
            return currentAuction.item_auction_id.equals(modifiedBid);
        });
        auctionToChange.winningBid.value = newValue;
        auctionToChange.winningBid.user_id = ObjectId(newUser);
        auctionToChange.winningBid._id = ObjectId(newBidId);

        if (!saveEnabled) {
            return res.status(500).send(auction);
        }
        auction.save(function(error, savedAuction) {
            if (error) {
                return res.status(500).send(savedAuction);
            }
            return res.status(200).send(savedAuction);
        });
    });
}

function removeBid(req, res) {
    var saveEnabled = res.locals.saveEnabled;
    var query = req.body.query;
    var modifiedBid = req.body.modifiedBid;

    Auction.findOne(query, function(error, auction) {
        if (error) {
            return res.status(500).send(error);
        }
        var auctionToChange = auction.bidHistory.find(function(currentBid) {
            return currentBid._id.equals(modifiedBid);
        });

        var removeIndex = auction.bidHistory.indexOf(auctionToChange);
        if (removeIndex > -1) {
            auction.bidHistory.splice(removeIndex, 1);
            auction.markModified("bidHistory");
        }

        if (!saveEnabled) {
            return res.status(500).send(auction);
        }
        auction.save(function(error, savedAuction) {
            if (error) {
                return res.status(500).send(savedAuction);
            }
            return res.status(200).send(savedAuction);
        });
    });
}

/**
 * requires current user to by gigit admin
 * @swagger
 * /api/maintenance/demonetize/{userId}:
 * post:
 *   summary: demonetize a User or Group (sets user.registeredForPaid = false, and removes user's StripeAccount document)
 *   consumes:
 *     - application/json
 *   parameters:
 *     - in: path
 *       userId: ObjectId of User or Group to demonetize
 *     - in: body
 *       save: A save token to confirm that changes are intended (must be epoch timestamp between Now and 5 minutes from Now)
 *   responses:
 *     '204':
 *       description: User is demonetized
 *     '404':
 *       description: Count not find user or stripeAccount
 *     '500':
 *       description: Error
 */
function demonetize(req, res) {
    return Promise.try(function() {
        var userId = req.params.userId;

        // Get User
        var userPromise = User.findById(userId)
            .catch(function(err) {
                logger.error("Error finding User: ", err);
                throw createError("Error finding User: " + err.message);
            })
            .then(function(user) {
                if (!user) {
                    throw createError(404, "User not found: " + userId);
                }
                return user;
            });

        // Get StripeAccount
        var stripeAccountPromise = StripeAccount.findOne({ user_id: userId })
            .catch(function(err) {
                logger.error("Error finding StripeAccount: ", err);
                throw createError("Error finding StripeAccount: " + err.message);
            })
            .then(function(stripeAccount) {
                if (!stripeAccount) {
                    throw createError(404, "StripeAccount not found: " + userId);
                }
                return stripeAccount;
            });

        return Promise.join(userPromise, stripeAccountPromise,
            function(user, stripeAccount) {
                user.registeredForPaid = false;
                return user.save()
                    .catch(function(err) {
                        logger.error("Error saving User: ", err);
                        throw createError("Error saving User: " + err.message);
                    })
                    .then(function() {
                        return stripeAccount.remove()
                            .catch(function(err) {
                                logger.error("Error removing StripeAccount: ", err);
                                throw createError("Error removing StripeAccount: " + err.message);
                            });
                    })
                    .then(function() {
                        res.status(204).send();
                    });
            });
    });
}

function errorTest(req, res) {
    return Promise.try(function() {
        throw createError(400, "Error test");
    });
}

router.get("/maintenance/statistics", getStatistics);
router.get("/maintenance/status", getStatus);

router.post("/maintenance/generic", [reqGigitAdmin, reqGenericModel()], genericGetRoute);
router.post("/maintenance/generic/ref", [reqGigitAdmin, reqGenericModel(), reqGenericModel("refModel")], genericRefRoute);
router.put("/maintenance/generic", [reqGigitAdmin, reqGenericModel(), reqSaveToken], genericCreateRoute);
router.delete("/maintenance/generic", [reqGigitAdmin, reqGenericModel(), optSaveToken], genericDeleteRoute);
router.post("/maintenance/generic/unique", [reqGigitAdmin, reqGenericModel()], genericUniqueRoute);
router.post("/maintenance/addArrayDuplicates", [reqGigitAdmin, reqGenericModel(), optSaveToken], addArrayDuplicates);
router.post("/maintenance/removeArrayDuplicates", [reqGigitAdmin, reqGenericModel(), optSaveToken], removeArrayDuplicates);
router.post("/maintenance/addValues", [reqGigitAdmin, reqGenericModel(), optSaveToken], addUniqueValuesToList);
router.post("/maintenance/duplicateTest", [reqGigitAdmin, reqGenericModel()], testForDuplicates);
router.post("/maintenance/testAggregate", [reqGigitAdmin, reqGenericModel()], testAggregate);
router.post("/maintenance/generic/array", [reqGigitAdmin, reqGenericModel(), reqSaveToken], modifyArrayValue);
router.put("/maintenance/generic/array", [reqGigitAdmin, reqGenericModel(), optSaveToken], pushArrayValue);
router.post("/maintenance/inject/", [reqGigitAdmin, reqGenericModel(), optSaveToken], genericInject);
router.post("/maintenance/transfer/", [reqGigitAdmin, reqGenericModel("toModel"), reqGenericModel("fromModel"), reqSaveToken], genericTransfer);
router.post("/maintenance/translate/", [reqGigitAdmin, reqGenericModel(), reqSaveToken], genericTranslate);
router.post("/maintenance/change/", [reqGigitAdmin, reqGenericModel(), optSaveToken], genericChangeField);

router.post("/maintenance/addTicketHolders", [reqGigitAdmin, optSaveToken], addTicketHolders);
router.post("/maintenance/fireEmail", [reqGigitAdmin], fireEmail);
router.post("/maintenance/changeEmailStatus", [reqGigitAdmin, optSaveToken], changeEmailStatus);
router.post("/maintenance/importStudents", [reqGigitAdmin, optSaveToken], importStudents);
router.post("/maintenance/authentication/", [reqGigitAdmin], getAuthenticationToken);
router.post("/maintenance/resetPassword", [reqGigitAdmin], resetPassword);
router.post("/maintenance/createLink/:groupId", [reqGigitAdmin], createRegistrationLink);
router.post("/maintenance/rating", [reqGigitAdmin], updateRatingFor);
router.post("/maintenance/decodeToken", [reqGigitAdmin], decodeToken);

router.post("/maintenance/resetAuction/:itemAuctionId", [reqGigitAdmin, optSaveToken], resetAuction);
router.post("/maintenance/removeBid", [reqGigitAdmin, optSaveToken], removeBid);
router.post("/maintenance/modifyBid", [reqGigitAdmin, optSaveToken], modifyBid);

router.post("/maintenance/demonetize/:userId", [reqGigitAdmin, reqSaveToken], demonetize);

router.get("/maintenance/error", errorTest);

module.exports = router;
