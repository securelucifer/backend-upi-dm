import mongoose from 'mongoose';

const transactionSchema = new mongoose.Schema({
  tid: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  orderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Order',
    default: null
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  payType: {
    type: String,
    enum: ['phonepe', 'paytm'],
    required: true
  },
  upi: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed', 'expired'],
    default: 'pending'
  },
  payload: {
    type: String
  },
  signature: {
    type: String
  },
  redirectUrl: {
    type: String
  },
  note: {
    type: String
  },
  upiRef: {
    type: String
  },
  expires: {
    type: Date,
    required: true,
    index: true
  },
  completedAt: {
    type: Date
  },
  errorMessage: {
    type: String
  }
}, {
  timestamps: true
});

// ✅ Auto-cleanup: MongoDB removes pending transactions after 24h past expiry
transactionSchema.index(
  { expires: 10 },
  { expireAfterSeconds: 86400, partialFilterExpression: { status: 'pending' } }
);

export default mongoose.model('Transaction', transactionSchema);
