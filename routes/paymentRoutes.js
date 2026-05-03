import express from 'express';
import {
    checkPaymentStatus,
    createPayment,
    getMerchantUPI,
    paymentWebhook,
    simulatePayment,
    verifyPayment,
    adminApprovePayment,
    adminRejectPayment,
    getAllTransactions,
    deleteTransaction
} from '../controllers/paymentController.js';

const router = express.Router();

router.post('/create', createPayment);
router.get('/status/:tid', checkPaymentStatus);
router.post('/verify', verifyPayment);
router.get('/merchant-upi', getMerchantUPI);
router.post('/webhook', paymentWebhook);

// ✅ Admin payment actions
router.post('/admin-approve', adminApprovePayment);
router.post('/admin-reject', adminRejectPayment);
router.get('/transactions', getAllTransactions);
router.delete('/transaction/:tid', deleteTransaction); 

// Testing only
router.post('/simulate', simulatePayment);

export default router;