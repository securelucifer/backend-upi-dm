import crypto from 'crypto';
import Transaction from '../models/Transaction.js';
import Settings from '../models/Setting.js';
import Order from '../models/Order.js';
import { io } from '../server.js';

const MERCHANT_SECRET = process.env.MERCHANT_SECRET || 'my_super_secret_key';

const generateTransactionId = () => {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 15);
    return `cw${timestamp}${random}`;
};

const generateNote = () => {
    return `s${Math.floor(Math.random() * 900) + 100}`;
};

const createSignature = (payload) => {
    return crypto.createHmac('sha256', MERCHANT_SECRET).update(payload).digest('hex');
};

/**
 * @desc    Create payment transaction
 * @route   POST /api/payment/create
 * @access  Public
 */
export const createPayment = async (req, res) => {
    try {
        const { amount, payType, orderId, userId } = req.body;

        if (!amount || !payType) {
            return res.status(400).json({ error: 'Invalid payload' });
        }

        const paymentAmount = parseFloat(amount);
        const paymentType = payType.toLowerCase().trim();

        if (!['phonepe', 'paytm'].includes(paymentType)) {
            return res.status(400).json({ error: 'Unsupported payment type' });
        }

        const settings = await Settings.getSettings();
        const MERCHANT_UPI = settings.merchantUPI;

        const tid = generateTransactionId();
        const expires = Math.floor(Date.now() / 1000) + 600;
        const note = generateNote();

        const userAgent = req.headers['user-agent'] || '';
        const isIOS = /iPad|iPhone|iPod/.test(userAgent);
        const isAndroid = /Android/.test(userAgent);

        let response, payloadB64, signature, redirectUrl, iosUrl, androidUrl;

        if (paymentType === 'phonepe') {
            const payloadJson = {
                contact: { cbsName: '', nickName: '', vpa: MERCHANT_UPI, type: 'VPA' },
                p2pPaymentCheckoutParams: {
                    note,
                    isByDefaultKnownContact: true,
                    initialAmount: Math.floor(paymentAmount * 100),
                    currency: 'INR',
                    checkoutType: 'DEFAULT',
                    transactionContext: 'p2p'
                }
            };

            const payloadStr = JSON.stringify(payloadJson);
            payloadB64 = Buffer.from(payloadStr).toString('base64');
            signature = createSignature(payloadB64);
            const payloadUrlenc = encodeURIComponent(payloadB64);

            androidUrl = `phonepe://native?data=${payloadUrlenc}&id=p2ppayment`;
            iosUrl = `phonepe://pay?pa=${encodeURIComponent(MERCHANT_UPI)}&pn=Merchant&am=${paymentAmount}&tn=${encodeURIComponent(note)}&cu=INR`;
            redirectUrl = isIOS ? iosUrl : androidUrl;

            response = {
                redirect_url: redirectUrl, ios_url: iosUrl, android_url: androidUrl,
                payload: payloadB64, sig: signature, expires, tid,
                amount: paymentAmount.toString(),
                device: isIOS ? 'iOS' : isAndroid ? 'Android' : 'Desktop'
            };

        } else if (paymentType === 'paytm') {
            const queryParams = new URLSearchParams({
                pa: MERCHANT_UPI, am: paymentAmount, tn: note, pn: MERCHANT_UPI,
                mc: '', cu: 'INR', url: '', mode: '', purpose: '', orgid: '', sign: '', featuretype: 'money_transfer'
            });

            redirectUrl = `paytmmp://cash_wallet?${queryParams.toString()}`;
            iosUrl = `paytm://pay?${queryParams.toString()}`;

            const payloadJson = { redirect: redirectUrl, tid, exp: expires };
            payloadB64 = Buffer.from(JSON.stringify(payloadJson)).toString('base64');
            signature = createSignature(payloadB64);

            response = {
                redirect_url: redirectUrl, ios_url: iosUrl, android_url: redirectUrl,
                payload: payloadB64, sig: signature, expires, tid,
                amount: paymentAmount.toString(),
                device: isIOS ? 'ios' : isAndroid ? 'android' : 'desktop'
            };
        }

        // Save transaction
        const transaction = new Transaction({
            tid, userId: userId || null, orderId: orderId || null,
            amount: paymentAmount, payType: paymentType, upi: MERCHANT_UPI,
            status: 'pending', payload: payloadB64, signature, redirectUrl, note,
            expires: new Date(expires * 1000)
        });

        await transaction.save();

        // ✅ Update Order with tid
        if (orderId) {
            await Order.findByIdAndUpdate(orderId, { tid });
        }

        // ✅ Emit Socket.io event to admin panel
        if (orderId) {
            try {
                const order = await Order.findById(orderId).select(
                    'orderNumber deliveryAddress products orderSummary paymentMethod'
                );

                if (order) {
                    io.to('admin_room').emit('new_payment_initiated', {
                        tid,
                        orderId: orderId.toString(),
                        orderNumber: order.orderNumber,
                        userName: order.deliveryAddress.fullName,
                        phone: order.deliveryAddress.phone,
                        address: {
                            address: order.deliveryAddress.address,
                            city: order.deliveryAddress.city,
                            state: order.deliveryAddress.state,
                            pincode: order.deliveryAddress.pincode
                        },
                        products: order.products.map(p => ({
                            name: p.name,
                            quantity: p.quantity,
                            price: p.dmartPrice,
                            image: p.image
                        })),
                        totalAmount: order.orderSummary.finalTotal,
                        payType: paymentType,
                        createdAt: new Date().toISOString()
                    });

                    console.log(`📢 Socket emitted: new_payment_initiated for order ${order.orderNumber}`);
                }
            } catch (socketErr) {
                console.error('Socket emit error (non-critical):', socketErr.message);
            }
        }

        console.log(`✅ Transaction created: ${tid} for ₹${paymentAmount}`);
        res.status(200).json(response);

    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({ error: 'Failed to create payment', message: error.message });
    }
};

/**
 * @desc    Check payment status by TID
 * @route   GET /api/payment/status/:tid
 * @access  Public
 */
export const checkPaymentStatus = async (req, res) => {
    try {
        const { tid } = req.params;

        if (!tid) return res.status(400).json({ error: 'Transaction ID is required' });

        const transaction = await Transaction.findOne({ tid });

        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        if (transaction.status === 'pending' && new Date() > transaction.expires) {
            transaction.status = 'expired';
            await transaction.save();

            if (transaction.orderId) {
                await Order.findByIdAndUpdate(transaction.orderId, {
                    paymentStatus: 'failed',
                    orderStatus: 'cancelled'
                });
            }
        }

        res.status(200).json({
            tid: transaction.tid,
            status: transaction.status,
            amount: transaction.amount,
            payType: transaction.payType,
            upi: transaction.upi,
            createdAt: transaction.createdAt,
            completedAt: transaction.completedAt
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to check payment status', message: error.message });
    }
};

/**
 * @desc    Admin approves payment — THE ONLY WAY to mark payment success
 * @route   POST /api/payment/admin-approve
 * @access  Admin only
 */
export const adminApprovePayment = async (req, res) => {
    try {
        const { tid } = req.body;

        if (!tid) return res.status(400).json({ error: 'Transaction ID is required' });

        const transaction = await Transaction.findOne({ tid });

        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        if (transaction.status !== 'pending') {
            return res.status(400).json({ error: `Transaction already ${transaction.status}` });
        }

        // ✅ Mark transaction as success
        transaction.status = 'success';
        transaction.completedAt = new Date();
        await transaction.save();

        // ✅ Update linked order
        let orderNumber = null;
        if (transaction.orderId) {
            const order = await Order.findById(transaction.orderId);
            if (order) {
                order.paymentStatus = 'paid';
                order.status = 'confirmed';
                await order.save();
                orderNumber = order.orderNumber;
            }
        }

        // ✅ Emit real-time event to ALL clients (user's PaymentStatus page will catch this)
        io.emit('payment_approved', {
            orderId: transaction.orderId?.toString(),
            tid: transaction.tid,
            amount: transaction.amount
        });

        console.log(`✅ Admin approved payment: ${tid}`);

        res.status(200).json({
            success: true,
            message: 'Payment approved successfully',
            tid,
            orderNumber,
            amount: transaction.amount
        });

    } catch (error) {
        console.error('Admin approve error:', error);
        res.status(500).json({ error: 'Failed to approve payment', message: error.message });
    }
};

/**
 * @desc    Admin rejects payment
 * @route   POST /api/payment/admin-reject
 * @access  Admin only
 */
export const adminRejectPayment = async (req, res) => {
    try {
        const { tid } = req.body;

        if (!tid) return res.status(400).json({ error: 'Transaction ID is required' });

        const transaction = await Transaction.findOne({ tid });

        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        if (transaction.status !== 'pending') {
            return res.status(400).json({ error: `Transaction already ${transaction.status}` });
        }

        transaction.status = 'failed';
        transaction.completedAt = new Date();
        await transaction.save();

        if (transaction.orderId) {
            await Order.findByIdAndUpdate(transaction.orderId, {
                paymentStatus: 'failed',
                status: 'cancelled'
            });
        }

        // ✅ Emit rejection event to user
        io.emit('payment_rejected', {
            orderId: transaction.orderId?.toString(),
            tid: transaction.tid
        });

        console.log(`❌ Admin rejected payment: ${tid}`);

        res.status(200).json({ success: true, message: 'Payment rejected', tid });

    } catch (error) {
        res.status(500).json({ error: 'Failed to reject payment', message: error.message });
    }
};

/**
 * @desc    Get all transactions for admin history table
 * @route   GET /api/payment/transactions
 * @access  Admin only
 */
export const getAllTransactions = async (req, res) => {
    try {
        const { page = 1, limit = 20, status } = req.query;

        let query = {};
        if (status) query.status = status;

        const transactions = await Transaction.find(query)
            .sort({ createdAt: -1 })
            .limit(limit * 1)
            .skip((page - 1) * limit)
            .populate('orderId', 'orderNumber deliveryAddress products orderSummary status paymentStatus');

        const total = await Transaction.countDocuments(query);

        res.status(200).json({
            success: true,
            data: transactions,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / limit),
                total,
                hasNextPage: page < Math.ceil(total / limit)
            }
        });

    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch transactions', message: error.message });
    }
};

/**
 * @desc    Verify payment (keep for backward compat)
 * @route   POST /api/payment/verify
 * @access  Public
 */
export const verifyPayment = async (req, res) => {
    try {
        const { tid, status, signature } = req.body;

        if (!tid || !status) return res.status(400).json({ error: 'Transaction ID and status are required' });

        const transaction = await Transaction.findOne({ tid });
        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        if (signature) {
            const expectedSig = createSignature(transaction.payload);
            if (signature !== expectedSig) return res.status(400).json({ error: 'Invalid signature' });
        }

        if (transaction.status !== 'pending') return res.status(400).json({ error: `Transaction already ${transaction.status}` });

        transaction.status = status;
        transaction.completedAt = new Date();
        await transaction.save();

        if (transaction.orderId) {
            const order = await Order.findById(transaction.orderId);
            if (order) {
                order.paymentStatus = status === 'success' ? 'paid' : 'failed';
                order.status = status === 'success' ? 'confirmed' : 'cancelled';
                await order.save();
            }
        }

        res.status(200).json({ success: true, message: `Payment ${status}`, tid: transaction.tid, status: transaction.status, amount: transaction.amount });

    } catch (error) {
        res.status(500).json({ error: 'Failed to verify payment', message: error.message });
    }
};

/**
 * @desc    Webhook for automatic payment detection
 * @route   POST /api/payment/webhook
 * @access  Public
 */
export const paymentWebhook = async (req, res) => {
    try {
        const { tid, status, amount, upi_ref, signature } = req.body;

        if (!tid || !status) return res.status(400).json({ error: 'Invalid webhook data' });

        const transaction = await Transaction.findOne({ tid });
        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        if (signature) {
            const expectedSig = crypto.createHmac('sha256', MERCHANT_SECRET).update(`${tid}${status}${amount}`).digest('hex');
            if (signature !== expectedSig) return res.status(400).json({ error: 'Invalid signature' });
        }

        if (transaction.status === 'pending') {
            transaction.status = status;
            transaction.completedAt = new Date();
            if (upi_ref) transaction.upiRef = upi_ref;
            await transaction.save();

            if (transaction.orderId) {
                const order = await Order.findById(transaction.orderId);
                if (order) {
                    order.paymentStatus = status === 'success' ? 'paid' : 'failed';
                    order.status = status === 'success' ? 'confirmed' : 'cancelled';
                    await order.save();
                }
            }

            if (status === 'success') {
                io.emit('payment_approved', {
                    orderId: transaction.orderId?.toString(),
                    tid: transaction.tid,
                    amount: transaction.amount
                });
            }
        }

        res.status(200).json({ success: true, message: 'Webhook processed' });

    } catch (error) {
        res.status(500).json({ error: 'Webhook processing failed', message: error.message });
    }
};

/**
 * @desc    Get merchant UPI
 * @route   GET /api/payment/merchant-upi
 * @access  Public
 */
export const getMerchantUPI = async (req, res) => {
    try {
        const settings = await Settings.getSettings();
        res.status(200).json({ upi: settings.merchantUPI });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get merchant UPI' });
    }
};

/**
 * @desc    Simulate payment (TESTING ONLY)
 * @route   POST /api/payment/simulate
 * @access  Public
 */
export const simulatePayment = async (req, res) => {
    try {
        const { tid, status } = req.body;
        if (!tid || !status) return res.status(400).json({ error: 'TID and status required' });

        const transaction = await Transaction.findOne({ tid });
        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
        if (transaction.status !== 'pending') return res.status(400).json({ error: `Transaction already ${transaction.status}` });

        transaction.status = status;
        transaction.completedAt = new Date();
        transaction.upiRef = `SIM${Date.now()}`;
        await transaction.save();

        if (transaction.orderId) {
            await Order.findByIdAndUpdate(transaction.orderId, {
                paymentStatus: status === 'success' ? 'paid' : 'failed',
                orderStatus: status === 'success' ? 'confirmed' : 'cancelled'
            });
        }

        if (status === 'success') {
            io.emit('payment_approved', { orderId: transaction.orderId?.toString(), tid });
        }

        res.json({ success: true, message: `Payment simulated as ${status}`, tid, status, amount: transaction.amount });

    } catch (error) {
        res.status(500).json({ error: 'Simulation failed' });
    }
};




/**
 * @desc    Admin deletes transaction AND its linked order permanently
 * @route   DELETE /api/payment/transaction/:tid
 * @access  Admin only
 */
export const deleteTransaction = async (req, res) => {
    try {
        const { tid } = req.params;
        if (!tid) return res.status(400).json({ error: 'Transaction ID is required' });

        // Step 1: Find the transaction first
        const transaction = await Transaction.findOne({ tid });
        if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

        const linkedOrderId = transaction.orderId;

        // Step 2: Delete the Transaction document
        await Transaction.findOneAndDelete({ tid });
        console.log(`🗑️ Transaction deleted: ${tid}`);

        // Step 3: Delete the linked Order document (THIS IS THE MISSING STEP)
        let deletedOrderNumber = null;
        if (linkedOrderId) {
            const order = await Order.findByIdAndDelete(linkedOrderId);
            if (order) {
                deletedOrderNumber = order.orderNumber;
                console.log(`🗑️ Linked Order deleted: ${order.orderNumber}`);
            }
        }

        // Step 4: Emit socket event so all admin tabs remove it instantly (no refresh needed)
        io.to('admin_room').emit('transaction_deleted', {
            tid,
            orderId: linkedOrderId?.toString() || null,
            orderNumber: deletedOrderNumber
        });

        res.status(200).json({
            success: true,
            message: 'Transaction and linked order deleted successfully',
            tid,
            deletedOrderNumber,
            orderId: linkedOrderId?.toString() || null
        });

    } catch (error) {
        console.error('Delete transaction error:', error);
        res.status(500).json({ error: 'Failed to delete transaction', message: error.message });
    }
};