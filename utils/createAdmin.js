import mongoose from 'mongoose';
import Admin from '../models/Admin.js';
import dotenv from 'dotenv';

dotenv.config();

const createDefaultAdmin = async () => {
    try {
        console.log('🔧 Starting admin creation process...');
        console.log('📍 MongoDB URI:', process.env.MONGODB_URI?.replace(/\/\/.*@/, '//***:***@'));

        await mongoose.connect(process.env.MONGODB_URI, {
            dbName: "DmartUpinew",
        });

        console.log('✅ Connected to MongoDB');

        // Check if admin exists
        console.log('🔍 Checking for existing admin...');
        const existingAdmin = await Admin.findOne({ username: process.env.ADMIN_USERNAME });

        if (existingAdmin) {
            console.log('✅ Admin already exists');
            console.log(`👤 Username: ${existingAdmin.username}`);
            console.log(`📧 Email: ${existingAdmin.email}`);
            console.log(`🟢 Active: ${existingAdmin.isActive}`);

            // Test password verification
            const adminWithPassword = await Admin.findOne({
                username: process.env.ADMIN_USERNAME
            }).select('+password');

            if (adminWithPassword) {
                console.log('🔍 Testing password verification...');
                const isMatch = await adminWithPassword.comparePassword(process.env.ADMIN_PASSWORD);
                console.log('🔍 Password verification result:', isMatch);

                if (!isMatch) {
                    console.log('⚠️ Password mismatch. Updating password...');
                    adminWithPassword.password = process.env.ADMIN_PASSWORD;
                    await adminWithPassword.save();
                    console.log('✅ Password updated successfully');
                }
            }

            process.exit(0);
        }

        // Create new admin
        console.log('🔧 Creating new admin user...');
        const admin = new Admin({
            username: process.env.ADMIN_USERNAME,
            email: process.env.ADMIN_EMAIL,
            password: process.env.ADMIN_PASSWORD,
            name: 'System Administrator',
            isActive: true
        });

        await admin.save();
        console.log('✅ Admin created successfully');
        console.log(`👤 Username: ${process.env.ADMIN_USERNAME}`);
        console.log(`📧 Email: ${process.env.ADMIN_EMAIL}`);
        console.log(`🔐 Password: ${process.env.ADMIN_PASSWORD}`);

        // Verify the created admin
        console.log('🔍 Verifying created admin...');
        const verifyAdmin = await Admin.findOne({
            username: process.env.ADMIN_USERNAME
        }).select('+password');

        if (verifyAdmin) {
            const testMatch = await verifyAdmin.comparePassword(process.env.ADMIN_PASSWORD);
            console.log('🔍 Post-creation verification:', testMatch);
            console.log('🆔 Admin ID:', verifyAdmin._id);
        }

    } catch (error) {
        console.error('❌ Error creating admin:', error.message);
        if (error.code === 11000) {
            console.error('💡 Duplicate key error - admin might already exist with different case');
        }
    } finally {
        console.log('🔌 Closing MongoDB connection...');
        await mongoose.connection.close();
        process.exit(0);
    }
};

createDefaultAdmin();
