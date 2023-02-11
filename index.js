const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const mg = require('nodemailer-mailgun-transport');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 5000;

const app = express();

// MiddleWares 
app.use(cors());
app.use(express.json());


// booking email function 
const sendBookingEmail = () => {
    const { email, treatment, appointmentDate, slot } = booking;
    const auth = {
        auth: {
            api_key: process.env.MAIGUN_KEY,
            domain: process.env.MAILGUN_DOMAIN
        }
    }

    const transporter = nodemailer.createTransport(mg(auth));


    // let transporter = nodemailer.createTransport({
    //     host: 'smtp.sendgrid.net',
    //     port: 587,
    //     auth: {
    //         user: "apikey",
    //         pass: process.env.SENDGRID_API_KEY
    //     }
    // });
    transporter.sendMail({
        from: "SENDER_EMAIL", // verified sender email
        to: { email }, // recipient email
        subject: `Your appointment for ${treatment} is confirmed`, // Subject line
        text: "Hello world!", // plain text body
        html: `
        <h3>Your Appointment is Confirmed.</h3>
        <div>
        <p>Your appointment for ${treatment}</p>
        <p>Please visit us at ${appointmentDate} on ${slot}.</p>
        <p>Thanks from Doctors Portal!!!</p>

        </div>
        `, // html body
    }, function (error, info) {
        if (error) {
            console.log(error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });
}




// jwt Middleware verify function
const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('Unauthorized Access');
    }

    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.WEB_TOKEN_SECRET, function (err, decoded) {
        // console.log(decoded);
        if (err) {
            return res.status(403).send('Forbidden Access');
        }
        req.decoded = decoded;
        next();
    })
}



const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.tl2ww1y.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


const run = async () => {
    try {
        // Collections 
        const appointOptCollection = client.db('doctorsPortal').collection('AppointmentOpts');
        const bookingsCollection = client.db('doctorsPortal').collection('bookings');
        const usersCollection = client.db('doctorsPortal').collection('users');
        const doctorsCollection = client.db('doctorsPortal').collection('doctors');
        const paymentsCollection = client.db('doctorsPortal').collection('payments');

        // Admin verifying middleware 
        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            // console.log(decodedEmail);
            const query = { email: decodedEmail };
            const user = await usersCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'Forbidden Access' });
            };

            next();
        };

        // Getting data 
        app.get('/appointOpts', async (req, res) => {
            const date = req.query.date;
            const query = {}
            const options = await appointOptCollection.find(query).toArray();
            const bookingQuery = { appointmentDate: date };
            const todaysBook = await bookingsCollection.find(bookingQuery).toArray();
            options.map(option => {
                const optionsBooked = todaysBook.filter(book => book.treatment === option.name);
                const bookedSlots = optionsBooked.map(book => book.slot);
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot));
                option.slots = remainingSlots;
            })
            res.send(options);
        });

        // Getting Appointment data 
        app.get('/bookings', verifyJWT, verifyAdmin, async (req, res) => {
            const email = req.query.email;
            const query = { email: email }
            const bookings = await bookingsCollection.find(query).toArray();
            res.send(bookings);
        })

        // Getting specific booking data by id 
        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const booking = await bookingsCollection.findOne(query);
            res.send(booking);
        });

        // Posting data 
        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            const query = {
                email: booking.email,
                appointmentDate: booking.appointmentDate,
                treatment: booking.treatment,
            };
            const alreadyBooked = await bookingsCollection.find(query).toArray();
            if (alreadyBooked.length) {
                const message = `You already booked a seat on ${booking.appointmentDate}`;
                return res.send({ acknowledge: false, message });
            }
            const result = await bookingsCollection.insertOne(booking);

            // sending booking email 
            sendBookingEmail(booking);
            res.send(result);
        });

        // Payment Method 
        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'bdt',
                "payment_method_types": [
                    "card"
                ],
            })
            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        })

        // Inserting payment data in DB 
        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId;
            const filter = { _id: ObjectId(id) };
            const updatedDoc = {
                $set: {
                    paid: true,
                    trxId: payment.trxId
                }
            }
            const updatedResult = await bookingsCollection.updateOne(filter, updatedDoc);
            res.send(result);
        })

        // Generate JWT token 
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await usersCollection.findOne(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.WEB_TOKEN_SECRET, { expiresIn: '7d' });
                return res.send({ accessToken: token });
            }
            res.status(403).send({ accessToken: '' });
        })

        // Creating user in dB 
        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await usersCollection.insertOne(user);
            res.send(result);
        })

        // Getting Users 
        app.get('/users', async (req, res) => {
            const query = {};
            const users = await usersCollection.find(query).toArray();
            res.send(users);
        })

        // Matching Admin
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await usersCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' });
        })

        // Creating Admin With Update method 
        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const options = { upsert: true };
            const updatedDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await usersCollection.updateOne(filter, updatedDoc, options);
            res.send(result);
        })

        // Adding temporary price in appointOptCollection
        // app.get('/addPrice', async (req, res) => {
        //     const filter = {};
        //     const options = { upsert: true };
        //     const updatedDoc = {
        //         $set: {
        //             price: 120
        //         }
        //     };
        //     const result = await appointOptCollection.updateMany(filter, updatedDoc, options);
        //     res.send(result);
        // })

        // Getting a specific property form Mongodb 

        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {};
            const result = await appointOptCollection.find(query).project({ name: 1 }).toArray();
            res.send(result);
        })

        // Posting doctors data 
        app.post('/doctors', verifyAdmin, async (req, res) => {
            const doctor = req.body;
            // console.log(doctor);
            const result = await doctorsCollection.insertOne(doctor);
            res.send(result);
        })

        // getting doctors data 
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {}
            const result = await doctorsCollection.find(query).toArray();
            res.send(result);
        });

        // Deleting doctor 
        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const result = await doctorsCollection.deleteOne(filter);
            res.send(result);
        })
    }
    finally { }
}

run().catch();



app.get('/', (req, res) => {
    res.send('Doctors portal is running..');
});

app.listen(port, (req, res) => {
    console.log('server is running on port: ', port);
})